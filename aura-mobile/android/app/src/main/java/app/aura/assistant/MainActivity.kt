package app.aura.assistant

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.util.Locale

class MainActivity : Activity() {
    companion object { const val ASSET_ORIGIN = "https://appassets.androidplatform.net" }
    lateinit var web: WebView
        private set
    lateinit var bridge: AuraBridge
        private set
    private var speech: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var pageReady = false
    private val stateListener: () -> Unit = { emitState() }
    private val stopListener: () -> Unit = { stopListeningNative(); stopSpeakingNative(); emit(JSONObject().put("type", "audio_stop").put("reason", "ai_mode_off")) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = android.graphics.Color.rgb(9, 13, 21)
        window.navigationBarColor = android.graphics.Color.rgb(9, 13, 21)
        bridge = AuraBridge(this)
        web = WebView(this)
        web.setBackgroundColor(android.graphics.Color.rgb(9, 13, 21))
        web.setOnApplyWindowInsetsListener { view, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() or android.view.WindowInsets.Type.displayCutout())
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            } else {
                @Suppress("DEPRECATION")
                view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = if (BuildConfig.DEBUG) android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW else android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            safeBrowsingEnabled = true
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val response = loader.shouldInterceptRequest(request.url)
                if (response != null) {
                    val connections = if (BuildConfig.DEBUG) "https: wss: http: ws:" else "https: wss:"
                    response.responseHeaders = (response.responseHeaders ?: emptyMap()) + mapOf(
                        "Content-Security-Policy" to "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src $connections; img-src 'self' data:; media-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'",
                        "X-Content-Type-Options" to "nosniff"
                    )
                }
                return response
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !trusted(request.url)
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                pageReady = false
                if (!trusted(Uri.parse(url ?: ""))) {
                    view.removeJavascriptInterface("AuraAndroid")
                    view.stopLoading()
                }
            }
            override fun onPageFinished(view: WebView, url: String?) {
                pageReady = trusted(Uri.parse(url ?: ""))
                if (pageReady) emitState()
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    // WebRTC voice is possible only after Android mic consent, AI mode,
                    // and a user action in the trusted UI; camera is never granted.
                    if (request.origin.toString().trimEnd('/') == ASSET_ORIGIN && AssistantSession.aiMode && microphoneGranted()
                        && request.resources.isNotEmpty() && request.resources.all { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    } else request.deny()
                }
            }
        }
        web.addJavascriptInterface(bridge, "AuraAndroid")
        setContentView(web)
        AssistantSession.stateListeners.add(stateListener)
        AssistantSession.shutdownListeners.add(stopListener)
        tts = TextToSpeech(this) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) tts?.language = Locale.getDefault()
        }.also { engine ->
            engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = Unit
                override fun onDone(utteranceId: String?) { emit(JSONObject().put("type", "speech_end")) }
                @Deprecated("Android legacy error callback")
                override fun onError(utteranceId: String?) { emit(JSONObject().put("type", "speech_end")); error("Android text-to-speech could not finish the reply.") }
                override fun onStop(utteranceId: String?, interrupted: Boolean) { emit(JSONObject().put("type", "speech_end")) }
            })
        }
        web.loadUrl("$ASSET_ORIGIN/assets/index.html")
    }

    private fun trusted(uri: Uri): Boolean = uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.path?.startsWith("/assets/") == true
    fun microphoneGranted(): Boolean = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    fun notificationsGranted(): Boolean {
        val manager = getSystemService(android.app.NotificationManager::class.java)
        val runtime = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val channel = manager.getNotificationChannel(AssistantModeService.CHANNEL)
        return runtime && manager.areNotificationsEnabled() && channel?.importance != android.app.NotificationManager.IMPORTANCE_NONE
    }
    fun emitState() = emit(JSONObject().put("type", "state").put("state", bridge.state()))
    fun error(message: String) = emit(JSONObject().put("type", "error").put("message", message))
    fun emit(payload: JSONObject) {
        runOnUiThread {
            if (pageReady && trusted(Uri.parse(web.url ?: ""))) {
                // JSONObject quoting prevents result text from becoming JavaScript source.
                web.evaluateJavascript("window.dispatchEvent(new CustomEvent('aura-native',{detail:${payload}}));", null)
            }
        }
    }
    fun startListeningNative() {
        if (!AssistantSession.aiMode) { error("Turn on AI mode before using the microphone."); return }
        if (!microphoneGranted()) { requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 40); return }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) { error("No Android speech recognizer is installed. You can type your message."); return }
        stopListeningNative()
        speech = SpeechRecognizer.createSpeechRecognizer(this).also { recognizer ->
            recognizer.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) = Unit
                override fun onBeginningOfSpeech() = Unit
                override fun onRmsChanged(rmsdB: Float) = Unit
                override fun onBufferReceived(buffer: ByteArray?) = Unit
                override fun onEndOfSpeech() = Unit
                override fun onError(error: Int) {
                    if (AssistantSession.aiMode) this@MainActivity.error(when(error) {
                        SpeechRecognizer.ERROR_NO_MATCH -> "No speech recognized. Try again."
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission is required."
                        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Android speech service could not connect."
                        else -> "Speech recognition stopped (code $error)."
                    })
                }
                override fun onResults(results: Bundle?) {
                    if (!AssistantSession.aiMode) return
                    val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                    if (text.isNotBlank()) emit(JSONObject().put("type", "speech_result").put("text", text.take(12000)))
                }
                override fun onPartialResults(partialResults: Bundle?) = Unit
                override fun onEvent(eventType: Int, params: Bundle?) = Unit
            })
            recognizer.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            })
        }
    }
    fun stopListeningNative() { speech?.cancel(); speech?.destroy(); speech = null }
    fun speakNative(text: String) {
        if (!AssistantSession.aiMode) return
        if (!ttsReady) { error("Android text-to-speech is not ready. Check your system voice settings."); return }
        tts?.setSpeechRate(0.96f)
        if (tts?.speak(text.take(4000), TextToSpeech.QUEUE_FLUSH, null, "aura_reply") == TextToSpeech.ERROR) {
            emit(JSONObject().put("type", "speech_end")); error("Android text-to-speech could not start the reply.")
        }
    }
    fun stopSpeakingNative() { tts?.stop(); emit(JSONObject().put("type", "speaking_stopped")) }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        emitState()
    }
    override fun onResume() {
        super.onResume()
        if (::web.isInitialized) web.onResume()
        if (AssistantSession.aiMode && !notificationsGranted()) {
            AssistantSession.setMode(false)
            stopService(Intent(this, AssistantModeService::class.java))
            stopListeningNative(); stopSpeakingNative()
        }
        if (::bridge.isInitialized) emitState()
    }
    override fun onPause() {
        stopListeningNative(); stopSpeakingNative()
        emit(JSONObject().put("type", "audio_stop").put("reason", "app_backgrounded"))
        if (::web.isInitialized) web.onPause()
        super.onPause()
    }
    override fun onDestroy() {
        AssistantSession.stateListeners.remove(stateListener)
        AssistantSession.shutdownListeners.remove(stopListener)
        stopListeningNative(); tts?.shutdown(); tts = null
        pageReady = false
        web.removeJavascriptInterface("AuraAndroid"); web.destroy()
        super.onDestroy()
    }
}
