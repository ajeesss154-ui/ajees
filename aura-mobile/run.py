#!/usr/bin/env python3
"""Configure and run the private AURA backend; never embeds keys in the APK."""
from __future__ import annotations

import argparse
import getpass
import os
from pathlib import Path
import secrets

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / ".aura.env"
ALLOWED = {"AURA_PROVIDER", "AURA_ACCESS_TOKEN", "GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_LIVE_MODEL", "OPENAI_API_KEY", "OPENAI_MODEL", "AURA_ALLOWED_ORIGINS", "AURA_REQUESTS_PER_MINUTE"}


def configure():
    if CONFIG.exists() and input("Replace the local server configuration? [y/N] ").strip().lower() != "y":
        return
    provider = input("Provider [gemini/openai, default gemini]: ").strip().lower() or "gemini"
    if provider not in {"gemini", "openai"}:
        raise ValueError("Choose gemini or openai.")
    key = getpass.getpass(f"Your {provider} API key (hidden): ").strip()
    if not key or any(c.isspace() for c in key):
        raise ValueError("Enter a nonempty API key without whitespace.")
    default = "gemini-3.8-flash" if provider == "gemini" else "gpt-4.1-mini"
    model = input(f"Model [{default}]: ").strip() or default
    if any(c.isspace() for c in model) or len(model) > 150:
        raise ValueError("Enter a valid model identifier.")
    token = secrets.token_urlsafe(36)
    values = {"AURA_PROVIDER": provider, "AURA_ACCESS_TOKEN": token,
              "GEMINI_API_KEY" if provider == "gemini" else "OPENAI_API_KEY": key,
              "GEMINI_MODEL" if provider == "gemini" else "OPENAI_MODEL": model,
              "GEMINI_LIVE_MODEL": "gemini-3.8-live"}
    # Explicit origin list; add your own web origin if serving UI on another host.
    values["AURA_ALLOWED_ORIGINS"] = "http://localhost:8787,http://127.0.0.1:8787,https://appassets.androidplatform.net"
    raw = "\n".join(name + "=" + value for name, value in values.items()) + "\n"
    fd = os.open(CONFIG, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(raw)
    print("\nServer configuration saved locally. Provider key remains on this server.")
    print("Copy this AURA access token into the phone's connection settings:")
    print(token)
    print("Treat this token as private. Do not publish .aura.env.")


def load_config():
    if not CONFIG.exists():
        return
    for line in CONFIG.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name in ALLOWED:
            os.environ.setdefault(name, value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--setup", action="store_true", help="Set up provider key and generate a private phone access token.")
    parser.add_argument("--host", default="127.0.0.1", help="Default localhost. Use 0.0.0.0 only on a trusted development LAN or behind HTTPS.")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    if args.setup:
        configure()
        return
    load_config()
    import uvicorn
    print(f"AURA starting on {args.host}:{args.port}. One worker; access logging disabled.")
    uvicorn.run("backend.app:app", host=args.host, port=args.port, workers=1, access_log=False)


if __name__ == "__main__":
    main()
