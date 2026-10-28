# AURA Android shell

Native Android companion for the adjacent AURA web UI. Kotlin + platform Views; no Compose. The UI is served from Android assets at `https://appassets.androidplatform.net/assets/index.html` using AndroidX WebViewAssetLoader, not from a remote web page.

## Build

- JDK 17, Android SDK platform 35 and build-tools 35.0.0.
- Gradle 8.10.2, Android Gradle Plugin 8.7.3, Kotlin 2.0.21.
- Minimum Android 8.0 (API 26); compile/target Android 15 (API 35).
- Dependency: `androidx.webkit:webkit:1.12.1` from Google Maven.

Copy the root project's **web asset contents** into `app/src/main/assets/` before building (the entry must be `app/src/main/assets/index.html`). From this directory run `gradle :app:assembleDebug`. Install the resulting `app/build/outputs/apk/debug/app-debug.apk` with `adb install -r`. Use a release signing key outside source control for distribution. This project does not include private signing credentials.

Android Studio can import this Gradle project and install the SDK/toolchain. A Gradle wrapper may be generated with `gradle wrapper --gradle-version 8.10.2` in a prepared environment.

## What AI mode does

AI mode is explicit, off by default after each app-process restart, and accompanied by an ongoing foreground-session notification with **Stop AI mode**. It requires notification permission. The service keeps availability visible; it never continuously listens, captures a camera, collects screenshots, or reads accessibility text. Removing the app from Recents stops this session. Stop AI mode clears selected-screen text and stops native speech/TTS; the web UI must also close any WebRTC connection on the emitted event.

The foreground service uses Android's `specialUse` type with subtype `user_enabled_assistant_session`. This is a technical manifest declaration, not a claim of Google Play approval. Publishing through Google Play requires the publisher's own foreground-service/accessibility disclosures and review.

Microphone permission is requested through Android. Push-to-talk uses the device's SpeechRecognizer; a recognition provider may send audio to its own service. Replies use the installed Android TextToSpeech engine and its normal synthetic voice. This is not an actor voice clone. Native push-to-talk is cancelled when AURA leaves the foreground.

Optional web realtime voice may request **audio capture only**, from the exact packaged origin and only after AI mode and runtime mic permission are on. Camera and all other web permission requests are denied. The web UI must stop its media tracks when the app backgrounds or AI mode switches off; native emits `audio_stop` for both cases.

## Optional selected-screen access

The native disclosure explains access before opening Android Accessibility Settings. AURA cannot silently enable its accessibility service. Enabling Android accessibility is separate from enabling AI mode.

To read another app: turn on AI mode, open the supported target app, open the AURA notification, and tap **Read screen**. This explicit notification action reads an application accessibility window once, skipping SystemUI/notification windows. A single package identifier may be kept to select the app behind the shade; accessibility-event text is never read or recorded. The selected text stays in RAM for at most 60 seconds, is consumed once by `getScreenContext()`, and is cleared when AI mode ends. The UI should show it to the user before sending it to the backend. Direct capture while AURA is foreground returns a helpful error instead of reading the assistant's own interface.

Visible-node traversal is bounded to 1,500 nodes and 10,000 characters. Nodes marked password or editable are skipped with their descendants. Apps with no readable accessibility text cannot be captured. This is an accessibility-text handoff, not screenshot/image recognition.

Recognized sensitive packages are blocked: Android Settings and permission controllers, SystemUI, Google Play Services/login, LastPass, 1Password, Bitwarden, Authy, Google Authenticator, Microsoft Authenticator, and Duo. Package-name fragments for banks, PayPal, Paytm, PhonePe, UPI/GPay, wallets, Chase, Revolut, Monzo, HDFC, ICICI, SBI, and Axis Bank are also blocked. These checks are conservative heuristics, **not universal sensitive-app or password detection**. Do not share confidential screens; do not assume an unfamiliar financial/authentication app is detected. The package list is explicit in `AuraAccessibilityService.kt`.

## Approved actions

`executeAction` accepts a proposal `{id,type,label,arguments}`. It validates independently of the backend, generates its own preview, and opens a native confirmation dialog for every action. A unique proposal can be requested once; cancellation and failures are reported. AI mode must remain on. Supported types and exact argument keys:

| Type | Arguments |
| --- | --- |
| `home` | `{}` |
| `back` | `{}` |
| `scroll` | `{"direction":"forward"}` or `{"direction":"backward"}` |
| `open_url` | `{"url":"https://example.com"}` |
| `launch_app` | `{"package":"com.example.app"}` |

URLs permit only HTTP/HTTPS with a real host and no embedded credentials or control/whitespace characters. Installed-app launch permits only a validated Android package with a resolvable launcher activity. No arbitrary intents, JavaScript URLs, shell commands, automatic taps, or text entry are supported. Home/Back/scroll require the accessibility service. Scroll is limited to the same active supported app at preview and execution, excludes AURA and sensitive windows, and can fail while AURA is foreground. This build does not claim unattended cross-app navigation. A requested action is never reported as a verified outcome; inspect the destination yourself.

## Web/native contract

Global `AuraAndroid` has JavaScript-interface methods returning JSON strings:

- `getState()` → `{aiMode, accessibilityEnabled, microphoneGranted, notificationsGranted, platform:"android", serverUrl, accessToken}`
- `configure(serverUrl, token)` → updated state or `{error}`. Release backend URLs require HTTPS and no query/fragment/userinfo. Debug builds additionally permit local HTTP as described below. The token is a backend access token, never a model-provider API key.
- `setAiMode(boolean)` → updated state or `{error}`. If notification consent is missing, grants must finish and the user must enable mode again.
- `requestMicrophone()`, `requestAccessibility()` → state/request result.
- `startListening()`, `stopListening()`, `speak(text)`, `stopSpeaking()` → request status.
- `getScreenContext()` → `{text,source:"accessibility",captured_at}` or `{error}`.
- `executeAction(JSON.stringify(proposal))` → `{id,status:"awaiting_approval"}` or `{error}`. The final result is asynchronous.

Native events are `window` CustomEvents named `aura-native`, with JSON detail:

- `{type:"speech_result",text}`
- `{type:"state",state:{...}}`
- `{type:"error",message}`
- `{type:"action_result",id,status,message}`; status `requested` means Android accepted a request, not that the destination was verified.
- `{type:"audio_stop",reason:"app_backgrounded"|"ai_mode_off"}`
- `{type:"speech_end"}` and `{type:"speaking_stopped"}` for native TTS completion or stop.

Backend connection settings live in app-private SharedPreferences and backups are disabled. The trusted packaged UI receives the backend token through `getState()`; never inject third-party scripts into these assets. Provider API keys belong only on the backend. Web navigation to remote pages is blocked, file/content/universal file URL access is disabled, mixed content is blocked except for the explicitly local debug development path below, and a native Content-Security-Policy forbids external scripts, frames, and plugins. Keep JavaScript in local `.js` files; local styles and HTTPS/WSS backend connections are allowed.

## Local backend development

A debug APK accepts `http://localhost`, `http://127.0.0.1`, emulator host `http://10.0.2.2`, and canonical RFC1918 IPv4 literals (`10.x.x.x`, `172.16.x.x`–`172.31.x.x`, `192.168.x.x`), with an optional valid port/base path. Other HTTP hosts, public IPs, userinfo, query strings, fragments, and malformed or ambiguous IPv4 forms are rejected. Run the Python backend on your Windows PC's private LAN address and enter that address and your backend access token in AURA, or use `adb reverse tcp:PORT tcp:PORT` with localhost. Debug manifests allow cleartext transport and debug CSP additionally permits HTTP/WS connections; external scripts/frames remain blocked. Local development HTTP sends the access token and chat data unencrypted over that local network. Use a trusted test network. Release manifests forbid cleartext and release configuration accepts HTTPS only; production deployments require HTTPS. This local development mode does not make a public HTTP service acceptable.

## Verification boundary

An APK build proves compilation, not device behavior. Verify notification permission and stop, permission denial/revocation, microphone start/stop and app-background cleanup, screen selection/expiry/redaction, native action preview/cancel/duplicate protection, and your actual backend on a test device. Accessibility/OEM speech implementations vary. No camera, continuous surveillance, actor voice clone, or automatic OS-permission grant is implemented.
