"""Authenticated AURA HTTP API. Run: uvicorn backend.app:app --host 127.0.0.1."""
from __future__ import annotations

from collections import deque
from pathlib import Path
import secrets
import threading
import time
from typing import Annotated
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException

from .config import Settings, VERSION
from .models import ChatRequest, ChatResponse, InvalidModelResponse, parse_model_output
from .providers import HttpProvider, ProviderError

MAX_BODY_BYTES = 128000


class ApiError(Exception):
    def __init__(self, status_code, code, message, *, retry_after=None):
        super().__init__(message)
        self.status_code, self.code, self.message = status_code, code, message
        self.retry_after = retry_after


class BodyLimitMiddleware:
    """Bound request bodies, including chunked requests, before JSON decoding."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") not in {"POST", "PUT", "PATCH"}:
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        raw_length = headers.get(b"content-length")
        if raw_length is not None:
            try:
                length = int(raw_length)
                if length < 0:
                    raise ValueError
            except ValueError:
                return await self._reject(scope, receive, send, 400, "invalid_request", "Invalid request length.")
            if length > MAX_BODY_BYTES:
                return await self._reject(scope, receive, send, 413, "request_too_large", "The request is too large. Start a new conversation.")
        chunks, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body = message.get("body", b"")
            size += len(body)
            if size > MAX_BODY_BYTES:
                return await self._reject(scope, receive, send, 413, "request_too_large", "The request is too large. Start a new conversation.")
            chunks.append(body)
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        sent = False
        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()
        await self.app(scope, replay, send)

    @staticmethod
    async def _reject(scope, receive, send, status, code, message):
        response = JSONResponse({"error": {"code": code, "message": message}, "request_id": uuid4().hex}, status_code=status,
                                headers={"Cache-Control": "no-store"})
        await response(scope, receive, send)


class RateLimit:
    """A single-process per-server quota; use one worker or an external limiter."""
    def __init__(self, limit):
        self.limit = limit
        self.times = deque()
        self.lock = threading.Lock()

    def check(self):
        now = time.monotonic()
        with self.lock:
            while self.times and self.times[0] <= now - 60:
                self.times.popleft()
            if len(self.times) >= self.limit:
                wait = max(1, int(61 - (now - self.times[0])))
                raise ApiError(429, "server_rate_limited", "Too many requests. Please wait before trying again.", retry_after=wait)
            self.times.append(now)


def create_app(settings: Settings | None = None, provider=None):
    settings = settings or Settings.from_env()
    provider = provider or HttpProvider(settings)
    application = FastAPI(title="AURA Companion API", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)
    application.state.settings = settings
    application.state.provider = provider
    limiter = RateLimit(settings.requests_per_minute)

    @application.middleware("http")
    async def response_headers(request: Request, call_next):
        request.state.request_id = uuid4().hex
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith(("/v1/", "/health")):
            response.headers["Cache-Control"] = "no-store"
        return response

    def error_response(request, status, code, message, retry_after=None):
        content = {"error": {"code": code, "message": message},
                   "request_id": getattr(request.state, "request_id", uuid4().hex)}
        headers = {"Cache-Control": "no-store"}
        if retry_after is not None:
            headers["Retry-After"] = str(retry_after)
            content["error"]["retry_after"] = retry_after
        if status == 401:
            headers["WWW-Authenticate"] = "Bearer"
        return JSONResponse(content, status_code=status, headers=headers)

    @application.exception_handler(ApiError)
    async def handle_api_error(request: Request, error: ApiError):
        return error_response(request, error.status_code, error.code, error.message, error.retry_after)

    @application.exception_handler(ProviderError)
    async def handle_provider_error(request: Request, error: ProviderError):
        return error_response(request, error.status_code, error.code, error.message, error.retry_after)

    @application.exception_handler(HTTPException)
    async def handle_http_error(request: Request, error: HTTPException):
        codes = {401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "unsupported_provider",
                 429: "voice_session_rate_limited", 503: "voice_not_configured"}
        # Voice routes raise only fixed, human-readable setup messages; never
        # serialize arbitrary provider response objects or request contents.
        message = error.detail if isinstance(error.detail, str) else "The request could not be completed."
        return error_response(request, error.status_code, codes.get(error.status_code, "request_failed"), message)

    @application.exception_handler(RequestValidationError)
    async def handle_invalid_request(request: Request, error: RequestValidationError):
        # Pydantic's default response includes the rejected input, which can
        # contain private screen text. Return field names and safe guidance only.
        return error_response(request, 422, "invalid_request", "Invalid chat request. Check message lengths, the latest user message, and AI-mode permission for screen context.")

    async def require_auth(authorization: Annotated[str | None, Header()] = None):
        if not settings.token_configured:
            raise ApiError(503, "server_not_configured", "Set a strong AURA_ACCESS_TOKEN on the server before connecting a device.")
        scheme, _, token = (authorization or "").partition(" ")
        if scheme.lower() != "bearer" or not secrets.compare_digest(token.encode("utf-8"), settings.access_token.encode("utf-8")):
            raise ApiError(401, "unauthorized", "Enter the correct AURA access token in Connection settings.")
    require_auth.settings = settings

    @application.get("/health")
    async def health():
        return {"status": "ok" if settings.configured else "setup_required", "provider": settings.provider,
                "model": settings.model, "configured": settings.configured, "version": VERSION}

    @application.get("/v1/config", dependencies=[Depends(require_auth)])
    async def configuration():
        capabilities = ["chat", "screen_context", "action_proposals"]
        if settings.provider == "gemini" and settings.configured:
            capabilities.append("live_voice")
        return {"provider": settings.provider, "model": settings.model,
                "configured": settings.configured, "capabilities": capabilities}

    @application.post("/v1/chat", response_model=ChatResponse, dependencies=[Depends(require_auth)])
    async def chat(body: ChatRequest, request: Request):
        request_id = body.request_id or request.state.request_id
        request.state.request_id = request_id
        if not settings.configured:
            raise ApiError(503, "provider_not_configured", "Configure the AI provider key and model on the server to enable chat.")
        limiter.check()
        text = await provider.complete(body)
        try:
            reply, proposals = parse_model_output(text, allow_actions=body.ai_mode)
        except InvalidModelResponse as exc:
            raise ApiError(502, "provider_invalid_response", "The AI provider did not return a readable answer. Please try again.") from exc
        return ChatResponse(reply=reply, provider=settings.provider, model=settings.model,
                            proposals=proposals, request_id=request_id)

    # The optional voice module authenticates a short-lived session ticket with
    # the same dependency. Its WebSocket never exposes the provider API key.
    from .live import create_live_router
    application.include_router(create_live_router(require_auth))

    web_root = Path(__file__).resolve().parents[1] / "web"
    if web_root.is_dir():
        application.mount("/", StaticFiles(directory=web_root, html=True), name="web")
    application.add_middleware(BodyLimitMiddleware)
    if settings.allowed_origins:
        application.add_middleware(CORSMiddleware, allow_origins=list(settings.allowed_origins),
                                   allow_credentials=False, allow_methods=["GET", "POST"],
                                   allow_headers=["Authorization", "Content-Type"],
                                   expose_headers=["X-Request-ID", "Retry-After"])
    return application


app = create_app()
