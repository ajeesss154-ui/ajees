"""Public API and model-output validation; no phone actions execute here."""
from __future__ import annotations

from datetime import datetime
import json
import re
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

MAX_MESSAGES = 30
MAX_CONTENT = 12000
MAX_TOTAL_CONTENT = 60000


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


class Message(StrictModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_CONTENT)

    @field_validator("content")
    @classmethod
    def content_not_blank(cls, value):
        if not value.strip():
            raise ValueError("Message content cannot be blank.")
        return value


class ScreenContext(StrictModel):
    text: str = Field(min_length=1, max_length=20000)
    source: Literal["accessibility", "manual"]
    captured_at: datetime

    @field_validator("captured_at")
    @classmethod
    def timezone_required(cls, value):
        if value.utcoffset() is None:
            raise ValueError("Context capture time must include a timezone.")
        return value


class ChatRequest(StrictModel):
    messages: list[Message] = Field(min_length=1, max_length=MAX_MESSAGES)
    context: ScreenContext | None = None
    ai_mode: bool = Field(default=False, strict=True)
    request_id: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}$")] | None = None

    @model_validator(mode="after")
    def enforce_consent_and_bounds(self):
        if self.context is not None and not self.ai_mode:
            raise ValueError("Enable AI mode before sharing screen context.")
        if sum(len(message.content) for message in self.messages) > MAX_TOTAL_CONTENT:
            raise ValueError("Conversation is too long. Start a new conversation.")
        if self.messages[-1].role != "user":
            raise ValueError("The final message must be from the user.")
        return self


class ActionProposal(StrictModel):
    id: str = Field(default_factory=lambda: uuid4().hex, pattern=r"^[A-Za-z0-9_-]{1,64}$")
    type: Literal["open_url", "launch_app", "home", "back", "scroll"]
    label: str = Field(min_length=1, max_length=160)
    arguments: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def restrict_arguments(self):
        args = self.arguments
        if not self.label.strip():
            raise ValueError("Action label cannot be blank.")
        if self.type == "open_url":
            if set(args) != {"url"} or not isinstance(args["url"], str) or len(args["url"]) > 2048:
                raise ValueError("Open URL needs one valid URL.")
            try:
                url = args["url"]
                parts = urlsplit(url)
                port = parts.port
                if (parts.scheme.lower() not in {"http", "https"} or not parts.hostname
                        or parts.username is not None or parts.password is not None
                        or any(c.isspace() or ord(c) < 32 for c in url)):
                    raise ValueError
            except ValueError as exc:
                raise ValueError("Only HTTP(S) URLs without credentials are allowed.") from exc
        elif self.type == "launch_app":
            if (set(args) != {"package"} or not isinstance(args["package"], str)
                    or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+", args["package"])
                    or len(args["package"]) > 200):
                raise ValueError("Launch app needs a valid Android package name.")
        elif self.type == "scroll":
            if set(args) != {"direction"} or args["direction"] not in ("forward", "backward"):
                raise ValueError("Scroll direction must be forward or backward.")
        elif args:
            raise ValueError("Home and back actions take no arguments.")
        return self


class ChatResponse(StrictModel):
    reply: str = Field(min_length=1, max_length=20000)
    provider: str
    model: str
    proposals: list[ActionProposal] = Field(default_factory=list, max_length=5)
    request_id: str


class InvalidModelResponse(Exception):
    """The provider returned no usable text."""


def parse_model_output(text: str, *, allow_actions: bool) -> tuple[str, list[ActionProposal]]:
    """Accept ordinary text or controlled JSON, never turn prose into commands.

    Invalid individual action proposals are discarded; a valid reply still
    reaches the user. Action IDs are generated locally rather than trusted from
    the model. A structured response without a reply is considered invalid.
    """
    if not isinstance(text, str) or not text.strip() or len(text) > 100000:
        raise InvalidModelResponse()
    original = text.strip()
    candidate = original
    if candidate.startswith("```") and candidate.endswith("```"):
        lines = candidate.splitlines()
        if lines and lines[0].strip().lower() in ("```json", "```"):
            candidate = "\n".join(lines[1:-1]).strip()
    try:
        data = json.loads(candidate)
    except (ValueError, TypeError):
        # Some provider/model combinations do not support structured output.
        return original[:20000], []
    if not isinstance(data, dict) or "reply" not in data:
        return original[:20000], []
    reply = data.get("reply")
    if not isinstance(reply, str) or not reply.strip() or len(reply) > 20000:
        raise InvalidModelResponse()
    proposals = []
    if allow_actions and isinstance(data.get("proposals"), list):
        for raw in data["proposals"][:20]:
            if not isinstance(raw, dict):
                continue
            try:
                cleaned = dict(raw)
                cleaned.pop("id", None)
                proposal = ActionProposal.model_validate(cleaned)
                proposals.append(proposal)
                if len(proposals) == 5:
                    break
            except (ValueError, TypeError):
                continue
    return reply.strip(), proposals
