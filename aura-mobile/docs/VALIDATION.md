# Build validation

This file records checks against the supplied source and compiled development APK.

| Check | Result |
| --- | --- |
| Python API/provider/consent/error tests | 25 passed |
| Live ticket/protocol/session tests | 11 passed |
| Kotlin URL boundary cases | 27 passed |
| Real-Chrome mobile UI acceptance checks | 9 passed |
| Android debug APK assembly | Passed |
| Python and JavaScript syntax | Passed |

The browser checks ran the actual local UI in Chrome at a 412 × 915 viewport. Private API replies and native bridge acknowledgements were explicitly mocked for the UI cases. They check permission refusal, connection failure, delayed-result cancellation, one-shot context, memory persistence and safe rendering, action confirmation outcomes, and the compact layout. The screenshot was captured from the real initial UI without mock AI replies.

Backend tests mock provider calls. They verify auth, request bounds, context-consent enforcement, proposal validation, error reporting, one-use voice tickets, origin matching, quotas, replay rejection, audio protocol limits, and cleanup. They do not demonstrate a working provider key or live model availability.

The Android build uses SDK 35, AGP 8.7.3, Kotlin 2.0.21, Gradle 8.10.2, and JDK 21 targeting JVM 17. URL-boundary tests exercise production HTTPS restrictions and debug-only loopback/private-IP HTTP connections. The installed app must still be tested on a real phone.

## Reproduce

From the project root after installing backend dependencies:

```sh
python -m unittest discover -s backend/tests -v
python -m unittest backend.test_live -v
```

After installing development requirements, start the local backend and run:

```sh
python run.py
# In another terminal:
python tests/browser_smoke.py
```

Set `AURA_CHROME_BIN` to an existing Chromium/Chrome executable if Playwright's browser is not installed. Browser tests make no paid model calls.

For Android:

```sh
python tools/sync_assets.py
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

## Still requires the user's device and account

- Real Gemini chat responses, live audio quality, interruption behavior, quota, and account/model eligibility.
- Android microphone and notification permissions, system speech/TTS availability, and manufacturer restrictions.
- Accessibility activation, the selected-app window behind the notification shade, and actual approved app/system actions.
- LAN reachability/firewall configuration or the chosen production HTTPS deployment.

The APK is a development build. This validation does not claim a store release, unrestricted phone control, independent foundation-model training, or a completed live-provider deployment.
