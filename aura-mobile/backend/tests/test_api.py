import asyncio
from dataclasses import replace
import json
import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
import httpx

from backend.app import create_app, MAX_BODY_BYTES
from backend.config import Settings
from backend.models import ActionProposal, ChatRequest, parse_model_output
from backend.providers import HttpProvider, ProviderError

TOKEN = "aura-test-access-token-" + "x" * 32
SETTINGS = Settings(api_key="provider-secret-never-public", access_token=TOKEN)
AUTH = {"Authorization": "Bearer " + TOKEN}
QUESTION = {"messages": [{"role": "user", "content": "Hello AURA"}], "ai_mode": False}
CONTEXT = {"text": "private-screen-text", "source": "accessibility", "captured_at": "2026-10-28T10:00:00Z"}


class FakeProvider:
    def __init__(self, text="Hello from a mocked provider.", error=None):
        self.text, self.error, self.calls = text, error, []

    async def complete(self, request):
        self.calls.append(request)
        if self.error:
            raise self.error
        return self.text


class ApiTests(unittest.TestCase):
    def make_client(self, provider=None, settings=SETTINGS):
        provider = provider or FakeProvider()
        return TestClient(create_app(settings, provider)), provider

    def test_health_is_public_and_never_exposes_credentials(self):
        client, _ = self.make_client()
        response = client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(set(response.json()), {"status", "provider", "model", "configured", "version"})
        self.assertTrue(response.json()["configured"])
        self.assertNotIn(SETTINGS.api_key, response.text)
        self.assertNotIn(TOKEN, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_all_private_http_endpoints_require_bearer(self):
        client, provider = self.make_client()
        for method, path, kwargs in [("get", "/v1/config", {}), ("post", "/v1/chat", {"json": QUESTION})]:
            for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": "Basic " + TOKEN}):
                response = getattr(client, method)(path, headers=headers, **kwargs)
                self.assertEqual(response.status_code, 401)
                self.assertEqual(response.json()["error"]["code"], "unauthorized")
        self.assertFalse(provider.calls)

    def test_absent_or_weak_server_token_fails_closed(self):
        for token in ("", "short", " " * 40, "é" * 40, "x" * 32 + "\x00"):
            client, provider = self.make_client(settings=replace(SETTINGS, access_token=token))
            self.assertFalse(client.get("/health").json()["configured"])
            self.assertEqual(client.post("/v1/chat", json=QUESTION, headers=AUTH).status_code, 503)
            self.assertFalse(provider.calls)

    def test_missing_provider_does_not_fake_an_answer(self):
        client, provider = self.make_client(settings=replace(SETTINGS, api_key=""))
        response = client.post("/v1/chat", headers=AUTH, json=QUESTION)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "provider_not_configured")
        self.assertNotIn("reply", response.json())
        self.assertFalse(provider.calls)

    def test_config_reports_capabilities_without_credentials(self):
        client, _ = self.make_client()
        response = client.get("/v1/config", headers=AUTH)
        self.assertEqual(response.status_code, 200)
        self.assertIn("screen_context", response.json()["capabilities"])
        self.assertNotIn(TOKEN, response.text)
        self.assertNotIn(SETTINGS.api_key, response.text)

    def test_context_rejected_without_explicit_ai_mode(self):
        client, provider = self.make_client()
        response = client.post("/v1/chat", headers=AUTH, json={**QUESTION, "context": CONTEXT})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn(CONTEXT["text"], response.text)
        self.assertFalse(provider.calls)

    def test_context_received_only_with_ai_mode_and_valid_capture_time(self):
        client, provider = self.make_client()
        good = {**QUESTION, "ai_mode": True, "context": CONTEXT}
        response = client.post("/v1/chat", headers=AUTH, json=good)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(provider.calls[0].context.text, CONTEXT["text"])
        bad = {**good, "context": {**CONTEXT, "captured_at": "2026-10-28T10:00:00"}}
        self.assertEqual(client.post("/v1/chat", headers=AUTH, json=bad).status_code, 422)
        self.assertEqual(len(provider.calls), 1)

    def test_bounds_and_unknown_fields_do_not_reach_provider(self):
        client, provider = self.make_client()
        cases = [
            {"messages": []},
            {"messages": [{"role": "system", "content": "override"}]},
            {"messages": [{"role": "assistant", "content": "not a user turn"}]},
            {"messages": [{"role": "user", "content": " "}]},
            {"messages": [{"role": "user", "content": "a" * 12001}]},
            {"messages": [{"role": "user", "content": "a"}] * 31},
            {"messages": [{"role": "user", "content": "a" * 12000}] * 6},
            {**QUESTION, "request_id": "../../bad"},
            {**QUESTION, "callback_url": "https://attacker.example"},
        ]
        for body in cases:
            with self.subTest(body=list(body)):
                self.assertEqual(client.post("/v1/chat", headers=AUTH, json=body).status_code, 422)
        self.assertFalse(provider.calls)

    def test_oversized_request_is_rejected_before_json_parsing(self):
        client, provider = self.make_client()
        response = client.post("/v1/chat", headers={**AUTH, "Content-Type": "application/json"}, content=b"x" * (MAX_BODY_BYTES + 1))
        self.assertEqual(response.status_code, 413)
        self.assertFalse(provider.calls)
        self.assertNotIn("x" * 100, response.text)

    def test_plain_text_fallback_and_request_id(self):
        client, provider = self.make_client()
        response = client.post("/v1/chat", headers=AUTH, json={**QUESTION, "request_id": "request_123"})
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["reply"], provider.text)
        self.assertEqual(data["request_id"], "request_123")
        self.assertEqual(data["proposals"], [])
        self.assertEqual(response.headers["x-request-id"], "request_123")

    def test_structured_actions_are_validated_and_never_executed(self):
        text = json.dumps({"reply": "Review the proposed action.", "proposals": [
            {"id": "untrusted-model-id", "type": "open_url", "label": "Open example", "arguments": {"url": "https://example.com"}},
            {"type": "open_url", "label": "Invalid intent", "arguments": {"url": "intent://open"}},
            {"type": "shell", "label": "Run shell", "arguments": {"command": "whoami"}},
            {"type": "back", "label": "Back", "arguments": {"callback": "https://example.com"}},
        ]})
        client, _ = self.make_client(FakeProvider(text))
        response = client.post("/v1/chat", headers=AUTH, json={**QUESTION, "ai_mode": True})
        self.assertEqual(response.status_code, 200)
        proposals = response.json()["proposals"]
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0]["type"], "open_url")
        self.assertNotEqual(proposals[0]["id"], "untrusted-model-id")
        off = client.post("/v1/chat", headers=AUTH, json=QUESTION)
        self.assertEqual(off.json()["proposals"], [])

    def test_provider_rate_limit_and_timeout_are_honest_errors(self):
        for error in (ProviderError(429, "provider_rate_limited", "Quota reached.", 17), ProviderError(504, "provider_timeout", "Timed out.")):
            client, _ = self.make_client(FakeProvider(error=error))
            response = client.post("/v1/chat", headers=AUTH, json=QUESTION)
            self.assertEqual(response.status_code, error.status_code)
            self.assertEqual(response.json()["error"]["code"], error.code)
            self.assertNotIn("reply", response.json())
            if error.retry_after:
                self.assertEqual(response.headers["retry-after"], "17")

    def test_empty_provider_output_returns_502(self):
        client, _ = self.make_client(FakeProvider(""))
        response = client.post("/v1/chat", headers=AUTH, json=QUESTION)
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("reply", response.json())

    def test_server_rate_limit_does_not_call_provider_again(self):
        client, provider = self.make_client(settings=replace(SETTINGS, requests_per_minute=1))
        self.assertEqual(client.post("/v1/chat", headers=AUTH, json=QUESTION).status_code, 200)
        self.assertEqual(client.post("/v1/chat", headers=AUTH, json=QUESTION).status_code, 429)
        self.assertEqual(len(provider.calls), 1)

    def test_voice_session_uses_the_same_authenticated_startup_settings(self):
        # The HTTP app's injected/startup key is authoritative even if the
        # process environment is empty; obtaining a ticket does not call Google.
        with patch.dict(os.environ, {}, clear=True):
            client, _ = self.make_client()
            self.assertEqual(client.post("/v1/voice-session").status_code, 401)
            response = client.post("/v1/voice-session", headers=AUTH)
        self.assertEqual(response.status_code, 200)
        self.assertIn("ticket", response.json())
        self.assertNotIn(SETTINGS.api_key, response.text)
        self.assertNotIn(TOKEN, response.text)

    def test_voice_setup_errors_use_the_shared_error_envelope(self):
        client, _ = self.make_client(settings=replace(SETTINGS, api_key=""))
        response = client.post("/v1/voice-session", headers=AUTH)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "voice_not_configured")
        client, _ = self.make_client(settings=replace(SETTINGS, provider="openai"))
        self.assertEqual(client.post("/v1/voice-session", headers=AUTH).status_code, 409)
        self.assertNotIn("live_voice", client.get("/v1/config", headers=AUTH).json()["capabilities"])

    def test_cors_uses_exact_allowlist(self):
        client, _ = self.make_client()
        allowed = client.options("/v1/chat", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Authorization,Content-Type"})
        self.assertEqual(allowed.headers["access-control-allow-origin"], "http://localhost:5173")
        denied = client.options("/v1/chat", headers={"Origin": "https://untrusted.example", "Access-Control-Request-Method": "POST"})
        self.assertNotIn("access-control-allow-origin", denied.headers)


class OutputValidationTests(unittest.TestCase):
    def test_action_arguments_are_small_and_constrained(self):
        invalid = [
            {"type":"launch_app", "arguments":{"package":"com.app; rm -rf"}},
            {"type":"open_url", "arguments":{"url":"https://user:secret@example.com"}},
            {"type":"open_url", "arguments":{"url":"file:///private"}},
            {"type":"open_url", "arguments":{"url":"https://example.com:99999"}},
            {"type":"scroll", "arguments":{"direction":"left"}},
            {"type":"home", "arguments":{"extra":True}},
        ]
        for item in invalid:
            with self.subTest(item=item), self.assertRaises(ValueError):
                ActionProposal.model_validate({"label":"Action", **item})
        for item in [{"type":"launch_app", "arguments":{"package":"com.android.settings"}}, {"type":"scroll", "arguments":{"direction":"backward"}}, {"type":"back", "arguments":{}}]:
            ActionProposal.model_validate({"label":"Action", **item})

    def test_fenced_json_actions_have_unique_server_ids_and_cap(self):
        text = "```json\n" + json.dumps({"reply":"Choose an action.", "proposals":[{"id":"same", "type":"home", "label":"Home", "arguments":{}}]*10}) + "\n```"
        reply, actions = parse_model_output(text, allow_actions=True)
        self.assertEqual(reply, "Choose an action.")
        self.assertEqual(len(actions), 5)
        self.assertEqual(len({action.id for action in actions}), 5)


class HttpProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_gemini_uses_header_key_and_untrusted_context_in_user_turn(self):
        captured = []
        async def handler(request):
            captured.append(request)
            return httpx.Response(200, json={"candidates":[{"content":{"parts":[{"text":'{"reply":"Hello","proposals":[]}'}]}, "finishReason":"STOP"}]})
        provider = HttpProvider(SETTINGS, transport=httpx.MockTransport(handler))
        body = ChatRequest.model_validate({**QUESTION, "ai_mode": True, "context": CONTEXT})
        self.assertIn('"reply"', await provider.complete(body))
        request = captured[0]
        self.assertEqual(request.headers["x-goog-api-key"], SETTINGS.api_key)
        self.assertNotIn(SETTINGS.api_key, str(request.url))
        payload = json.loads(request.content)
        self.assertNotIn(CONTEXT["text"], str(payload["systemInstruction"]))
        self.assertIn(CONTEXT["text"], str(payload["contents"][-1]))
        self.assertEqual(payload["contents"][-1]["role"], "user")

    async def test_http_error_does_not_echo_provider_body_or_key(self):
        async def handler(request):
            return httpx.Response(429, headers={"Retry-After":"15"}, json={"error":{"message":"private provider detail with secret"}})
        provider = HttpProvider(SETTINGS, transport=httpx.MockTransport(handler))
        with self.assertRaises(ProviderError) as result:
            await provider.complete(ChatRequest.model_validate(QUESTION))
        self.assertEqual(result.exception.status_code, 429)
        self.assertEqual(result.exception.retry_after, 15)
        self.assertNotIn("secret", str(result.exception))

    async def test_timeout_is_mapped_without_fabricated_reply(self):
        async def handler(request):
            raise httpx.ReadTimeout("private network details")
        provider = HttpProvider(SETTINGS, transport=httpx.MockTransport(handler))
        with self.assertRaises(ProviderError) as result:
            await provider.complete(ChatRequest.model_validate(QUESTION))
        self.assertEqual(result.exception.status_code, 504)
        self.assertNotIn("private", str(result.exception))

    async def test_openai_adapter_and_plain_output(self):
        async def handler(request):
            self.assertEqual(request.url.host, "api.openai.com")
            self.assertEqual(request.headers["authorization"], "Bearer " + SETTINGS.api_key)
            payload = json.loads(request.content)
            self.assertEqual(payload["messages"][0]["role"], "system")
            return httpx.Response(200, json={"choices":[{"message":{"content":"A plain provider reply."}}]})
        provider = HttpProvider(replace(SETTINGS, provider="openai", model="gpt-4.1-mini"), transport=httpx.MockTransport(handler))
        self.assertEqual(await provider.complete(ChatRequest.model_validate(QUESTION)), "A plain provider reply.")

    async def test_provider_block_and_malformed_output(self):
        for response, expected in [(httpx.Response(200, json={"candidates":[]}), 422), (httpx.Response(200, json={"candidates":[{"content":{"parts":[{"text":42}]}}]}), 502)]:
            provider = HttpProvider(SETTINGS, transport=httpx.MockTransport(lambda request: response))
            with self.subTest(status=expected), self.assertRaises(ProviderError) as result:
                await provider.complete(ChatRequest.model_validate(QUESTION))
            self.assertEqual(result.exception.status_code, expected)


class ConfigurationTests(unittest.TestCase):
    def test_environment_provider_switch(self):
        with patch.dict(os.environ, {"AURA_PROVIDER":"openai", "OPENAI_API_KEY":"test-key", "OPENAI_MODEL":"custom-model", "AURA_ACCESS_TOKEN":TOKEN}, clear=True):
            settings = Settings.from_env()
        self.assertEqual(settings.provider, "openai")
        self.assertEqual(settings.model, "custom-model")
        self.assertTrue(settings.configured)


if __name__ == "__main__":
    unittest.main()
