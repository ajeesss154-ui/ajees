"""Opt-in Gemini Live voice relay. The provider key never reaches the client.

No raw audio, transcripts, tickets, or provider errors are written to application
logs. Run one backend worker unless ticket storage is replaced by shared storage.
"""
from __future__ import annotations

import asyncio
import base64
from collections import deque
from dataclasses import dataclass
import hashlib
import json
import os
import re
import secrets
import threading
import time
from typing import Callable
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from starlette.websockets import WebSocketDisconnect

UPSTREAM_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
TICKET_TTL = 60.0
SESSION_SECONDS = 600.0
MAX_TICKETS = 128
MAX_AUDIO_BYTES = 32_000
MAX_CLIENT_MESSAGE = 48_000


@dataclass(frozen=True)
class VoiceTicket:
    expires: float
    auth_digest: str
    origin: str | None


def _auth_digest(settings=None) -> str:
    token = getattr(settings, "access_token", None) if settings is not None else None
    return hashlib.sha256((token if token is not None else os.environ.get("AURA_ACCESS_TOKEN", "")).encode()).hexdigest()


def _bounded_env(name, default, maximum):
    try:
        return max(1, min(int(os.environ.get(name, str(default))), maximum))
    except (TypeError, ValueError):
        return default


def _configured(settings=None) -> tuple[str, str]:
    provider = getattr(settings, "provider", None) if settings is not None else None
    if (provider if provider is not None else os.environ.get("AURA_PROVIDER", "gemini")).strip().lower() != "gemini":
        raise HTTPException(409, "Live voice currently requires the Gemini provider.")
    configured_key = getattr(settings, "api_key", None) if settings is not None else None
    key = (configured_key if configured_key is not None else os.environ.get("GEMINI_API_KEY", "")).strip()
    if not key:
        raise HTTPException(503, "Set GEMINI_API_KEY on the backend to enable live voice.")
    model = os.environ.get("GEMINI_LIVE_MODEL", "gemini-3.8-live").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}", model):
        raise HTTPException(503, "The configured live model name is invalid.")
    return key, model


def allowed_origin(origin: str | None, configured_origins=None) -> bool:
    # Non-browser clients may omit Origin; a valid single-use ticket is still
    # mandatory. Browser origins are deliberately narrow rather than '*'.
    if origin is None:
        return True
    if configured_origins is not None:
        return origin in {value.rstrip("/") for value in configured_origins}
    configured = os.environ.get("AURA_ALLOWED_ORIGINS", os.environ.get("AURA_CORS_ORIGINS", ""))
    extra = {value.strip().rstrip("/") for value in configured.split(",") if value.strip()}
    if origin in extra or origin == "https://appassets.androidplatform.net":
        return True
    try:
        parsed = urlsplit(origin)
        return (parsed.scheme in {"http", "https"} and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
                and not parsed.username and not parsed.password and not parsed.path
                and not parsed.query and not parsed.fragment)
    except ValueError:
        return False


def client_message(payload: str) -> dict | None:
    """Map the app's bounded input grammar to Google's wire protocol."""
    if len(payload) > MAX_CLIENT_MESSAGE:
        raise ValueError("Live input is too large.")
    try:
        value = json.loads(payload)
    except (ValueError, TypeError) as exc:
        raise ValueError("Live input must be JSON.") from exc
    if not isinstance(value, dict):
        raise ValueError("Live input must be an object.")
    kind = value.get("type")
    if kind == "stop" and set(value) == {"type"}:
        return None
    if kind == "text" and set(value) == {"type", "text"}:
        text = value["text"]
        if not isinstance(text, str) or not text.strip() or len(text) > 4000:
            raise ValueError("Live text must contain 1–4000 characters.")
        return {"realtimeInput": {"text": text}}
    if kind == "audio" and set(value) == {"type", "data"}:
        encoded = value["data"]
        if not isinstance(encoded, str) or not encoded or len(encoded) > 43_000:
            raise ValueError("Invalid live audio chunk.")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise ValueError("Live audio must be base64 PCM.") from exc
        if not raw or len(raw) > MAX_AUDIO_BYTES or len(raw) % 2:
            raise ValueError("Live audio must be PCM16 mono in bounded chunks.")
        return {"realtimeInput": {"audio": {"data": encoded, "mimeType": "audio/pcm;rate=16000"}}}
    raise ValueError("Unsupported live input. Only audio, text, and stop are accepted.")


def provider_events(payload: str | bytes) -> list[dict]:
    """Expose only voice data. Provider tools never become device commands."""
    if len(payload) > 1_048_576:
        raise ValueError("Provider response exceeded the live limit.")
    event = json.loads(payload)
    if not isinstance(event, dict):
        raise ValueError("Invalid provider response.")
    if event.get("error"):
        raise RuntimeError("The voice provider declined the session.")
    output = []
    content = event.get("serverContent")
    if not isinstance(content, dict):
        return output
    if content.get("interrupted"):
        output.append({"type": "interrupted"})
    for key, role in (("inputTranscription", "user"), ("outputTranscription", "assistant")):
        transcript = content.get(key)
        if isinstance(transcript, dict) and isinstance(transcript.get("text"), str):
            output.append({"type": "transcript", "role": role, "text": transcript["text"][:8000]})
    model_turn = content.get("modelTurn")
    if isinstance(model_turn, dict):
        parts = model_turn.get("parts", [])
        for part in parts[:20] if isinstance(parts, list) else []:
            inline = part.get("inlineData") if isinstance(part, dict) else None
            if not isinstance(inline, dict):
                continue
            data, mime = inline.get("data"), inline.get("mimeType", "")
            if isinstance(data, str) and len(data) <= 350_000 and isinstance(mime, str) and mime.startswith("audio/pcm"):
                try:
                    decoded = base64.b64decode(data, validate=True)
                except ValueError:
                    continue
                if decoded and len(decoded) % 2 == 0:
                    output.append({"type": "audio", "data": data, "mime_type": mime[:100]})
    if content.get("turnComplete"):
        output.append({"type": "turn_complete"})
    return output


async def _client_to_provider(client: WebSocket, upstream):
    while True:
        payload = await asyncio.wait_for(client.receive_text(), timeout=75)
        outgoing = client_message(payload)
        if outgoing is None:
            await upstream.send(json.dumps({"realtimeInput": {"audioStreamEnd": True}}))
            return
        await upstream.send(json.dumps(outgoing))


async def _provider_to_client(client: WebSocket, upstream):
    async for payload in upstream:
        for event in provider_events(payload):
            await client.send_json(event)


async def _safe_close(client: WebSocket, code=1000):
    try:
        await client.close(code=code)
    except (RuntimeError, WebSocketDisconnect):
        pass


def create_live_router(auth_dependency: Callable) -> APIRouter:
    router = APIRouter()
    tickets: dict[str, VoiceTicket] = {}
    settings = getattr(auth_dependency, "settings", None)
    origins = getattr(settings, "allowed_origins", None) if settings is not None else None
    active_slots = threading.BoundedSemaphore(_bounded_env("AURA_MAX_LIVE_SESSIONS", 2, 8))
    ticket_rate = _bounded_env("AURA_VOICE_TICKETS_PER_MINUTE", 6, 60)
    issue_times: deque[float] = deque()

    @router.post("/v1/voice-session", dependencies=[Depends(auth_dependency)])
    async def voice_session(request: Request):
        _, model = _configured(settings)
        origin = request.headers.get("origin")
        if not allowed_origin(origin, origins):
            raise HTTPException(403, "This origin is not allowed to start live voice.")
        if not active_slots.acquire(blocking=False):
            raise HTTPException(503, "Live voice session capacity is full. Stop another session and retry.")
        active_slots.release()
        now = time.monotonic()
        while issue_times and issue_times[0] <= now - 60:
            issue_times.popleft()
        if len(issue_times) >= ticket_rate:
            raise HTTPException(429, "Too many voice session starts. Wait a minute before trying again.")
        for ticket, record in list(tickets.items()):
            if record.expires <= now:
                tickets.pop(ticket, None)
        if len(tickets) >= MAX_TICKETS:
            raise HTTPException(429, "Too many pending voice sessions. Retry shortly.")
        ticket = secrets.token_urlsafe(32)
        tickets[ticket] = VoiceTicket(now + TICKET_TTL, _auth_digest(settings), origin)
        issue_times.append(now)
        return {"ticket": ticket, "websocket_path": "/v1/live?ticket=" + ticket,
                "expires_in": int(TICKET_TTL), "provider": "gemini", "model": model,
                "input_format": "pcm16le/16000/mono", "output_format": "pcm16le/24000/mono",
                "max_session_seconds": int(SESSION_SECONDS)}

    @router.websocket("/v1/live")
    async def live(client: WebSocket):
        record = tickets.pop(client.query_params.get("ticket", ""), None)
        # Uvicorn formats WebSocket accept/deny access lines from this scope.
        # A consumed short-lived ticket should not appear in those log lines.
        client.scope["query_string"] = b""
        origin = client.headers.get("origin")
        if (record is None or record.expires <= time.monotonic() or record.auth_digest != _auth_digest(settings)
                or not allowed_origin(origin, origins) or (record.origin is not None and record.origin != origin)):
            await _safe_close(client, 4401)
            return
        try:
            key, model = _configured(settings)
        except HTTPException:
            await _safe_close(client, 4403)
            return
        if not active_slots.acquire(blocking=False):
            # Capacity can change between ticket issue and connection. Give the
            # authorized client a truthful error without opening a provider call.
            try:
                await client.accept()
                await client.send_json({"type": "error", "message": "Live voice session capacity is full. Stop another session and retry."})
            finally:
                await _safe_close(client, 1013)
            return
        tasks: list[asyncio.Task] = []
        try:
            await client.accept()
            import websockets
            # websockets uses the inherited proxy environment by default. The key
            # goes in a handshake header, never in a logged URL or a client packet.
            async with asyncio.timeout(SESSION_SECONDS):
                async with websockets.connect(UPSTREAM_URL, additional_headers={"x-goog-api-key": key},
                                              open_timeout=20, close_timeout=5, max_size=1_048_576,
                                              max_queue=8, ping_interval=20, ping_timeout=20) as upstream:
                    await upstream.send(json.dumps({"setup": {
                        "model": "models/" + model,
                        "generationConfig": {"responseModalities": ["AUDIO"], "speechConfig": {
                            "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Kore"}}}},
                        "systemInstruction": {"parts": [{"text": (
                            "You are AURA, a calm, concise personal assistant with an original synthetic voice. "
                            "Speak naturally in the user's language. You are not a movie actor or character. "
                            "This voice session has no phone controls, screen feed, account access, or web tools. "
                            "Never claim to view or operate the phone. Ask the user to use the app's text/action "
                            "workflow for device actions. Do not invent current facts."
                        )}]}, "inputAudioTranscription": {}, "outputAudioTranscription": {}}}))
                    setup = json.loads(await asyncio.wait_for(upstream.recv(), timeout=20))
                    if not isinstance(setup, dict) or "setupComplete" not in setup:
                        raise RuntimeError("Voice setup did not complete.")
                    await client.send_json({"type": "ready", "model": model})
                    tasks = [asyncio.create_task(_client_to_provider(client, upstream)),
                             asyncio.create_task(_provider_to_client(client, upstream))]
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    for task in done:
                        task.result()
        except WebSocketDisconnect:
            pass
        except asyncio.CancelledError:
            raise
        except ValueError as exc:
            try:
                await client.send_json({"type": "error", "message": str(exc)[:160]})
            except (RuntimeError, WebSocketDisconnect):
                pass
        except TimeoutError:
            try:
                await client.send_json({"type": "error", "message": "Voice session expired or timed out. Start a new session."})
            except (RuntimeError, WebSocketDisconnect):
                pass
        except Exception:
            try:
                await client.send_json({"type": "error", "message": "Could not connect to Gemini Live. Check backend connectivity, model access, quota, and API configuration."})
            except (RuntimeError, WebSocketDisconnect):
                pass
        finally:
            try:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
                await _safe_close(client)
            finally:
                active_slots.release()

    return router
