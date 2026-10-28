package app.aura.assistant

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.os.Build
import android.os.Looper
import android.provider.Settings
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.net.URI
import java.time.Instant
import java.util.concurrent.Callable
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit

class AuraBridge(private val activity: MainActivity) {
    private var actionPending = false
    private val preferences = activity.getSharedPreferences("aura_private_connection", android.content.Context.MODE_PRIVATE)

    fun state(): JSONObject = JSONObject()
        .put("aiMode", AssistantSession.aiMode)
        .put("accessibilityEnabled", AuraAccessibilityService.instance != null)
        .put("microphoneGranted", activity.microphoneGranted())
        .put("notificationsGranted", activity.notificationsGranted())
        .put("platform", "android")
        .put("serverUrl", preferences.getString("server_url", "").orEmpty())
        .put("accessToken", preferences.getString("access_token", "").orEmpty())

    @JavascriptInterface fun getState(): String = state().toString()

    @JavascriptInterface fun configure(serverUrl: String, token: String): String {
        return try {
            val cleanUrl = BackendUrlPolicy.validate(serverUrl, BuildConfig.DEBUG)
            require(token.length <= 4096 && token.none { it.isWhitespace() || it.code < 32 || it.code == 127 }) { "The access token contains invalid characters." }
            preferences.edit().putString("server_url", cleanUrl).putString("access_token", token).apply()
            activity.emitState()
            state().toString()
        } catch (error: Exception) { failure(error.message ?: "Invalid connection settings.") }
    }

    @JavascriptInterface fun setAiMode(enabled: Boolean): String = onMain {
        if (enabled) {
            if (Build.VERSION.SDK_INT >= 33 && !activity.notificationsGranted()) {
                activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41)
                return@onMain failure("Allow notifications, then turn on AI mode again. The session needs a visible stop control.")
            }
            if (!activity.notificationsGranted()) return@onMain failure("Enable AURA notifications in Android Settings before starting AI mode.")
            if (!activity.hasWindowFocus()) return@onMain failure("Open AURA before turning on AI mode.")
            try {
                AssistantSession.setMode(true)
                activity.startForegroundService(Intent(activity, AssistantModeService::class.java))
            } catch (error: Exception) {
                AssistantSession.setMode(false)
                return@onMain failure("Android could not start the visible AI-mode session. Open AURA and try again.")
            }
        } else {
            AssistantSession.setMode(false)
            activity.stopService(Intent(activity, AssistantModeService::class.java))
            activity.stopListeningNative(); activity.stopSpeakingNative()
        }
        state().toString()
    }

    @JavascriptInterface fun requestMicrophone(): String = onMain {
        if (!activity.microphoneGranted()) activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 40)
        state().toString()
    }

    @JavascriptInterface fun requestAccessibility(): String = onMain {
        AlertDialog.Builder(activity)
            .setTitle("Optional screen access")
            .setMessage("AURA can read visible text from a supported app only when you request Read screen while AI mode is on. It does not collect accessibility-event text. Password/editable fields and recognized sensitive apps are excluded. Screen content you send in chat goes to your AI provider. You can disable access in Android Settings at any time.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Open Android Settings") { _, _ ->
                activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }.show()
        JSONObject().put("status", "requested").toString()
    }

    @JavascriptInterface fun startListening(): String = onMain { activity.startListeningNative(); JSONObject().put("status", "requested").toString() }
    @JavascriptInterface fun stopListening(): String = onMain { activity.stopListeningNative(); JSONObject().put("status", "stopped").toString() }
    @JavascriptInterface fun speak(text: String): String = onMain { activity.speakNative(text); JSONObject().put("status", "requested").toString() }
    @JavascriptInterface fun stopSpeaking(): String = onMain { activity.stopSpeakingNative(); JSONObject().put("status", "stopped").toString() }

    @JavascriptInterface fun getScreenContext(): String = onMain {
        if (!AssistantSession.aiMode) return@onMain failure("Turn on AI mode before reading a screen.")
        val selected = AssistantSession.consumeScreen() // Every selected snapshot is consumed at most once.
        if (selected != null) {
            if (selected.has("error")) return@onMain selected.toString()
            val captured = runCatching { Instant.parse(selected.getString("captured_at")) }.getOrNull()
            if (captured != null && java.time.Duration.between(captured, Instant.now()).seconds in 0..60) return@onMain selected.toString()
            return@onMain failure("The selected screen expired. Use Read screen in the AI-mode notification again.")
        }
        (AuraAccessibilityService.instance?.captureScreen()
            ?: JSONObject().put("error", "Enable optional AURA accessibility access first.")).toString()
    }

    @JavascriptInterface fun executeAction(actionJson: String): String = onMain {
        try {
            require(AssistantSession.aiMode) { "Turn on AI mode before approving an action." }
            require(!actionPending) { "Finish the current action preview first." }
            require(actionJson.length <= 12000) { "Action proposal is too long." }
            val proposal = JSONObject(actionJson)
            val id = proposal.optString("id")
            require(id.matches(Regex("[A-Za-z0-9_.:-]{1,120}"))) { "Invalid action ID." }
            val type = proposal.optString("type")
            val args = proposal.optJSONObject("arguments") ?: throw IllegalArgumentException("Action arguments must be an object.")
            val allowedKeys: Set<String>
            var target = ""
            var direction = ""
            val preview = when (type) {
                "home" -> { allowedKeys = emptySet(); "Go to the Android home screen." }
                "back" -> { allowedKeys = emptySet(); "Perform Android Back in the current screen. This may leave your current page." }
                "scroll" -> {
                    allowedKeys = setOf("direction")
                    direction = args.optString("direction")
                    require(direction in setOf("forward", "backward")) { "Scroll direction must be forward or backward." }
                    "Scroll $direction once in the current supported screen."
                }
                "open_url" -> {
                    allowedKeys = setOf("url")
                    target = args.optString("url")
                    val uri = URI(target)
                    require(target.length <= 2048 && target.none { it.isWhitespace() || it.code < 32 } && uri.scheme in setOf("https", "http") && !uri.host.isNullOrBlank() && uri.userInfo == null) { "Only HTTP or HTTPS links without embedded credentials are allowed." }
                    "Open this address in your browser:\n\n$target"
                }
                "launch_app" -> {
                    allowedKeys = setOf("package")
                    target = args.optString("package")
                    require(target.length <= 200 && target.matches(Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+"))) { "Invalid application package name." }
                    require(activity.packageManager.getLaunchIntentForPackage(target) != null) { "That app is not installed or has no launchable activity." }
                    "Launch the installed app:\n\n$target"
                }
                else -> throw IllegalArgumentException("This action is not supported. AURA supports Home, Back, scroll, browser links, and installed-app launch only.")
            }
            require(args.keys().asSequence().all { it in allowedKeys }) { "Action has unsupported arguments." }
            if (type in setOf("home", "back", "scroll")) require(AuraAccessibilityService.instance != null) { "This action requires optional AURA accessibility access." }
            require(AssistantSession.claimAction(id)) { "This action has already been proposed. Request a new action to retry." }
            val activePackage = AuraAccessibilityService.instance?.activePackage().orEmpty()
            actionPending = true
            AlertDialog.Builder(activity)
                .setTitle("Approve one action")
                .setMessage(preview + "\n\nAI mode must remain on. This approval applies once.")
                .setNegativeButton("Cancel") { _, _ -> actionPending = false; actionResult(id, "cancelled", "You cancelled this action.") }
                .setOnCancelListener { actionPending = false; actionResult(id, "cancelled", "You dismissed this action.") }
                .setPositiveButton("Approve") { _, _ -> actionPending = false; performAction(id, type, target, direction, activePackage) }
                .show()
            JSONObject().put("id", id).put("status", "awaiting_approval").toString()
        } catch (error: Exception) { actionPending = false; failure(error.message ?: "The action could not be validated.") }
    }

    private fun performAction(id: String, type: String, target: String, direction: String, expectedPackage: String) {
        if (!AssistantSession.aiMode) { actionResult(id, "cancelled", "AI mode was turned off. Nothing was requested."); return }
        try {
            val requested = when (type) {
                "open_url" -> { activity.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(target)).addCategory(Intent.CATEGORY_BROWSABLE)); true }
                "launch_app" -> {
                    val intent = activity.packageManager.getLaunchIntentForPackage(target) ?: throw IllegalStateException("The application is no longer available.")
                    activity.startActivity(intent); true
                }
                else -> AuraAccessibilityService.instance?.performApprovedAction(type, direction, expectedPackage) == true
            }
            if (requested) actionResult(id, "requested", "Android accepted the request. Check the destination to confirm the result.")
            else actionResult(id, "failed", "Android could not perform the action in the current supported window.")
        } catch (_: Exception) { actionResult(id, "failed", "Android could not open or perform this action.") }
    }

    private fun actionResult(id: String, status: String, message: String) = activity.emit(JSONObject().put("type", "action_result").put("id", id).put("status", status).put("message", message))
    private fun failure(message: String): String { activity.error(message); return JSONObject().put("error", message).toString() }
    private fun onMain(block: () -> String): String {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val task = FutureTask(Callable { block() })
        activity.runOnUiThread(task)
        return try { task.get(5, TimeUnit.SECONDS) } catch (_: Exception) { task.cancel(false); JSONObject().put("error", "Android is busy. Open AURA and try again.").toString() }
    }
}
