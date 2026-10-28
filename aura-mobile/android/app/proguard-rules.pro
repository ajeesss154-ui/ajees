# The JavaScript bridge method names are part of the app's local interface.
-keepclassmembers class app.aura.assistant.AuraBridge {
    @android.webkit.JavascriptInterface <methods>;
}
