package app.aura.assistant

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONObject
import java.time.Instant
import java.util.ArrayDeque

class AuraAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile var instance: AuraAccessibilityService? = null
            private set
        private val sensitivePackages = setOf(
            "com.android.settings", "com.android.permissioncontroller", "com.google.android.permissioncontroller",
            "com.android.systemui", "com.google.android.gms", "com.google.android.gsf.login",
            "com.lastpass.lpandroid", "com.onepassword.android", "com.agilebits.onepassword",
            "com.x8bit.bitwarden", "com.bitwarden.authenticator", "com.authy.authy",
            "com.google.android.apps.authenticator2", "com.azure.authenticator", "com.duosecurity.duomobile"
        )
        private val sensitiveFragments = listOf("bank", "paypal", "paytm", "phonepe", ".upi", "gpay", "wallet", "chase", "revolut", "monzo", "hdfc", "icici", ".sbi", "axisbank")
        fun sensitive(packageName: String): Boolean {
            val name = packageName.lowercase()
            return name in sensitivePackages || sensitiveFragments.any { name.contains(it) }
        }
    }

    private var lastExternalPackage: String = ""

    override fun onServiceConnected() { instance = this }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // A single package identifier helps target the user-selected app behind the shade.
        // Never read, buffer, log, or send event text or node content here.
        val name = event?.packageName?.toString().orEmpty()
        if (AssistantSession.aiMode && name.isNotBlank() && name != packageName && name != "com.android.systemui") lastExternalPackage = name
    }
    override fun onInterrupt() = Unit
    override fun onDestroy() { if (instance === this) instance = null; super.onDestroy() }

    fun captureScreen(fromNotification: Boolean = false): JSONObject {
        if (!AssistantSession.aiMode) return JSONObject().put("error", "Turn on AI mode before reading a screen.")
        val root = if (fromNotification) {
            // The notification shade may be active. Select only an application window;
            // never capture SystemUI/notification windows or fall back to their text.
            windows.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
                .sortedByDescending { it.layer }
                .mapNotNull { it.root }
                .firstOrNull { node ->
                    val name = node.packageName?.toString().orEmpty()
                    node.isVisibleToUser && name.isNotBlank() && name != this.packageName && !sensitive(name)
                        && (lastExternalPackage.isBlank() || name == lastExternalPackage)
                }
        } else rootInActiveWindow
        if (root == null) return JSONObject().put("error", "No supported application window is available. Open the target app and try Read screen again.")
        val packageName = root.packageName?.toString().orEmpty()
        if (packageName.isBlank() || packageName == this.packageName) return JSONObject().put("error", "Open the app you want to read, then use Read screen in AURA’s AI-mode notification.")
        if (sensitive(packageName)) return JSONObject().put("error", "Screen reading is disabled for this sensitive app or system window.")
        val output = StringBuilder()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && output.length < 10000 && visited++ < 1500) {
            val node = queue.removeFirst()
            if (!node.isVisibleToUser || node.isPassword || node.isEditable) continue
            val nodePackage = node.packageName?.toString().orEmpty()
            if (nodePackage.isNotEmpty() && sensitive(nodePackage)) continue
            val text = node.text?.toString()?.trim().orEmpty()
            val description = node.contentDescription?.toString()?.trim().orEmpty()
            val piece = if (text.isNotEmpty()) text else description
            if (piece.isNotEmpty()) {
                if (output.isNotEmpty()) output.append('\n')
                output.append(piece.take(10000 - output.length))
            }
            for (i in 0 until node.childCount.coerceAtMost(100)) node.getChild(i)?.let(queue::addLast)
        }
        if (output.isEmpty()) return JSONObject().put("error", "This app exposes no supported visible text. Password and editable fields are excluded.")
        return JSONObject().put("text", output.toString().take(10000)).put("source", "accessibility").put("captured_at", Instant.now().toString())
    }

    fun activePackage(): String = rootInActiveWindow?.packageName?.toString().orEmpty()

    fun performApprovedAction(type: String, direction: String = "", expectedPackage: String = ""): Boolean {
        if (!AssistantSession.aiMode) return false
        return when (type) {
            "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "scroll" -> {
                val root = rootInActiveWindow ?: return false
                val packageName = root.packageName?.toString().orEmpty()
                if (packageName.isBlank() || packageName == this.packageName || sensitive(packageName) || (expectedPackage.isNotBlank() && packageName != expectedPackage)) return false
                val queue = ArrayDeque<AccessibilityNodeInfo>(); queue.add(root)
                var visited = 0
                while (queue.isNotEmpty() && visited++ < 500) {
                    val node = queue.removeFirst()
                    if (node.isPassword || node.isEditable) continue
                    if (node.isVisibleToUser && node.isScrollable) {
                        val action = if (direction == "forward") AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                        if (node.performAction(action)) return true
                    }
                    for (i in 0 until node.childCount.coerceAtMost(100)) node.getChild(i)?.let(queue::addLast)
                }
                false
            }
            else -> false
        }
    }
}
