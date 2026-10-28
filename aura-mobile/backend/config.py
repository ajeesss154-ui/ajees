"""Environment-only server credentials; public configuration never includes keys."""
from __future__ import annotations

from dataclasses import dataclass, field
import os

VERSION = "1.0.0"


@dataclass(frozen=True)
class Settings:
    provider: str = "gemini"
    model: str = "gemini-3.8-flash"
    api_key: str = field(default="", repr=False)
    access_token: str = field(default="", repr=False)
    allowed_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8787", "http://127.0.0.1:8787", "https://appassets.androidplatform.net")
    requests_per_minute: int = 30

    @property
    def token_configured(self):
        return 32 <= len(self.access_token) <= 512 and all(33 <= ord(c) <= 126 for c in self.access_token)

    @property
    def configured(self):
        return self.token_configured and bool(self.api_key.strip()) and self.provider in {"gemini", "openai"}

    @classmethod
    def from_env(cls):
        provider = os.getenv("AURA_PROVIDER", "gemini").strip().lower()
        if provider == "openai":
            model = os.getenv("OPENAI_MODEL", "gpt-4.1-mini").strip()
            key = os.getenv("OPENAI_API_KEY", "").strip()
        else:
            model = os.getenv("GEMINI_MODEL", "gemini-3.8-flash").strip()
            key = os.getenv("GEMINI_API_KEY", "").strip()
        origins = os.getenv("AURA_ALLOWED_ORIGINS")
        allowed = tuple(value.strip() for value in origins.split(",") if value.strip()) if origins is not None else cls.allowed_origins
        try:
            rpm = int(os.getenv("AURA_REQUESTS_PER_MINUTE", "30"))
        except ValueError:
            rpm = 30
        return cls(provider=provider, model=model, api_key=key,
                   access_token=os.getenv("AURA_ACCESS_TOKEN", "").strip(),
                   allowed_origins=allowed, requests_per_minute=max(1, min(rpm, 300)))
