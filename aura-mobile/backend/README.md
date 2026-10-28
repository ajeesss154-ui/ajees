# AURA companion API

Python 3.11+; all provider requests originate on this server. The browser/Android
app stores a device access token, never the Gemini/OpenAI provider key. Run one
worker for the included in-memory rate limiter; a multi-worker public deployment
needs an external shared rate limiter.

From the repository root:

```sh
python -m venv .venv
# Activate the virtual environment for your platform.
python -m pip install -r backend/requirements.txt
```

Set environment variables from `backend/.env.example` in your process or hosting
platform; this application does not automatically read `.env` files. Generate a
unique token with `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
Set `AURA_ACCESS_TOKEN` to that token (32+ non-whitespace characters), and set your
own `GEMINI_API_KEY` on the server. Provider access and quota are checked only by
an actual provider response. `configured` reports credential presence, not a live
connectivity test.

```sh
python -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

The server also serves the sibling `web/` directory when present. A physical phone
needs an HTTPS-reachable instance (not the phone's own `localhost`). Terminate TLS
at your deployment gateway. `AURA_ALLOWED_ORIGINS` is a comma-separated exact-origin
allowlist for separately hosted browser clients. Native HTTP clients do not rely
on CORS. No remote callback or arbitrary upstream URL can be supplied in requests.

Default Gemini model: `gemini-3.8-flash`, configurable with `GEMINI_MODEL`. Optional
OpenAI support uses `AURA_PROVIDER=openai`, `OPENAI_API_KEY`, and `OPENAI_MODEL`
(default `gpt-4.1-mini`). Use a model available to your own provider account.

## API

- `GET /health` — no authentication; status, provider, model, configured, version.
- `GET /v1/config` — `Authorization: Bearer <AURA_ACCESS_TOKEN>`; provider/model,
  credential-presence flag, capabilities.
- `POST /v1/voice-session` — same bearer auth; a single-use, 60-second live-voice
  ticket. Connect to the returned WebSocket path immediately. Gemini only.
- `WS /v1/live?ticket=...` — bounded PCM16 live audio and transcript relay; no
  screen feed or phone tools. Provider credentials remain on the server.
- `POST /v1/chat` — same bearer auth; request fields `messages`, optional `context`,
  `ai_mode`, optional `request_id`. Reply contains `reply`, `provider`, `model`,
  validated `proposals`, and `request_id`.

Screen context requires `ai_mode=true`. It is reference text, not permission to
act. Conversation text, screen text, access tokens, and provider replies are not
logged by this API. Provider requests transmit the submitted conversation and any
explicitly supplied context to the selected provider. Model action proposals are
never executed by this server. AI mode off always returns no proposals. Native
clients must independently validate actions and require explicit review/tap.
Allowed actions: `open_url` with `{url}`, `launch_app` with `{package}`, `home`
and `back` with `{}`, and `scroll` with `{direction: "forward"|"backward"}`.

Errors use `{error: {code, message, retry_after?}, request_id}`. Missing/invalid
server setup: 503; invalid token: 401; invalid input: 422; oversized request: 413;
provider/server rate limit: 429; timeout: 504; other provider failure: 502. Errors
never contain raw provider response bodies, submitted text, or credentials.

Run tests from the repository root:

```sh
python -m unittest discover -s backend/tests -v
python -m unittest backend.test_live -v
```
