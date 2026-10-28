"""Deterministic Live protocol and ticket tests; no provider/network required."""
import base64
import asyncio
import json
import os
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.live import allowed_origin, client_message, create_live_router, provider_events


class WireTests(unittest.TestCase):
    def test_pcm_and_input_grammar(self):
        audio = base64.b64encode(b"\x01\x00\xff\x7f").decode()
        self.assertEqual(client_message(json.dumps({"type": "audio", "data": audio})),
                         {"realtimeInput": {"audio": {"data": audio, "mimeType": "audio/pcm;rate=16000"}}})
        self.assertEqual(client_message('{"type":"text","text":"hello"}'), {"realtimeInput": {"text": "hello"}})
        self.assertIsNone(client_message('{"type":"stop"}'))
        for invalid in ['[]', '{}', 'bad', '{"type":"audio","data":"bad!"}',
                        '{"type":"audio","data":"AA=="}', '{"type":"text","text":""}',
                        '{"type":"stop","command":"shell"}', '{"setup":{"model":"attacker"}}']:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                client_message(invalid)

    def test_provider_event_filter_and_order(self):
        encoded = base64.b64encode(b"\x01\x00").decode()
        events = provider_events(json.dumps({"serverContent": {
            "interrupted": True, "inputTranscription": {"text": "hi"},
            "outputTranscription": {"text": "hello"},
            "modelTurn": {"parts": [{"inlineData": {"data": encoded, "mimeType": "audio/pcm;rate=24000"}}]},
            "turnComplete": True}, "toolCall": {"functionCalls": [{"name": "delete_everything"}]}}))
        self.assertEqual([e["type"] for e in events], ["interrupted", "transcript", "transcript", "audio", "turn_complete"])
        self.assertNotIn("delete_everything", json.dumps(events))
        self.assertEqual(provider_events('{"toolCall":{"functionCalls":[]}}'), [])

    def test_origins_are_narrow(self):
        with patch.dict(os.environ, {"AURA_ALLOWED_ORIGINS": "https://aura.example"}):
            for value in [None, "https://aura.example", "https://appassets.androidplatform.net", "http://localhost:8787", "http://127.0.0.1:9000"]:
                self.assertTrue(allowed_origin(value))
            for value in ["null", "http://attacker.example", "https://localhost.attacker.example", "http://user:pass@localhost", "http://localhost/path"]:
                self.assertFalse(allowed_origin(value))


class TicketTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"AURA_PROVIDER": "gemini", "GEMINI_API_KEY": "unit-test-key",
                                          "AURA_ACCESS_TOKEN": "x" * 40})
        self.env.start()
        app = FastAPI()
        def auth(authorization: str | None = Header(None)):
            if authorization != "Bearer " + os.environ["AURA_ACCESS_TOKEN"]:
                raise HTTPException(401, "Unauthorized")
        app.include_router(create_live_router(auth))
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.env.stop()

    def ticket(self, **kwargs):
        return self.client.post('/v1/voice-session', headers={"Authorization": "Bearer " + "x" * 40, **kwargs})

    def test_ticket_requires_auth_and_is_one_use_even_on_origin_failure(self):
        self.assertEqual(self.client.post('/v1/voice-session').status_code, 401)
        response = self.ticket(Origin="https://appassets.androidplatform.net")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload['input_format'], 'pcm16le/16000/mono')
        self.assertNotIn('unit-test-key', response.text)
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect(payload['websocket_path'], headers={"Origin": "http://evil.example"}):
                pass
        with self.assertRaises(WebSocketDisconnect):
            with self.client.websocket_connect(payload['websocket_path'], headers={"Origin": "https://appassets.androidplatform.net"}):
                pass

    def test_expired_tickets_and_auth_rotation(self):
        with patch('backend.live.time.monotonic', return_value=100):
            path = self.ticket().json()['websocket_path']
        with patch('backend.live.time.monotonic', return_value=161):
            with self.assertRaises(WebSocketDisconnect):
                with self.client.websocket_connect(path): pass
        path = self.ticket().json()['websocket_path']
        with patch.dict(os.environ, {"AURA_ACCESS_TOKEN": "new-token"}):
            with self.assertRaises(WebSocketDisconnect):
                with self.client.websocket_connect(path): pass

    def test_provider_and_origin_configuration(self):
        self.assertEqual(self.ticket(Origin='http://evil.example').status_code, 403)
        with patch.dict(os.environ, {"AURA_PROVIDER": "openai"}):
            self.assertEqual(self.ticket().status_code, 409)
        with patch.dict(os.environ, {"GEMINI_API_KEY": ""}):
            self.assertEqual(self.ticket().status_code, 503)

    def test_router_uses_injected_startup_settings(self):
        def auth(): return None
        auth.settings=SimpleNamespace(provider='gemini',api_key='startup-key',access_token='x'*40,
                                      allowed_origins=('https://appassets.androidplatform.net',))
        app=FastAPI(); app.include_router(create_live_router(auth))
        with patch.dict(os.environ,{'GEMINI_API_KEY':'','AURA_PROVIDER':'openai'}):
            with TestClient(app) as client:
                self.assertEqual(client.post('/v1/voice-session',headers={'Origin':'https://appassets.androidplatform.net'}).status_code,200)
                self.assertEqual(client.post('/v1/voice-session',headers={'Origin':'http://localhost:8787'}).status_code,403)

    def test_ticket_queue_is_bounded(self):
        with patch('backend.live.MAX_TICKETS', 3):
            for _ in range(3): self.assertEqual(self.ticket().status_code, 200)
            self.assertEqual(self.ticket().status_code, 429)

    def test_ticket_rate_limit_and_reset(self):
        with patch('backend.live.time.monotonic', return_value=100):
            for _ in range(6): self.assertEqual(self.ticket().status_code, 200)
            self.assertEqual(self.ticket().status_code, 429)
        with patch('backend.live.time.monotonic', return_value=161):
            self.assertEqual(self.ticket().status_code, 200)

    def test_live_capacity_is_bounded_and_released(self):
        class Connection:
            async def __aenter__(self): return self
            async def __aexit__(self, *_): return False
            async def send(self, _): pass
            async def recv(self): return '{"setupComplete":{}}'
            def __aiter__(self): return self
            async def __anext__(self): await asyncio.Future()
        # Three valid outstanding tickets, but only two may start provider calls.
        paths=[self.ticket().json()['websocket_path'] for _ in range(3)]
        with patch('websockets.connect', side_effect=lambda *_a,**_k:Connection()) as connect:
            with self.client.websocket_connect(paths[0]) as first:
                self.assertEqual(first.receive_json()['type'],'ready')
                with self.client.websocket_connect(paths[1]) as second:
                    self.assertEqual(second.receive_json()['type'],'ready')
                    self.assertEqual(self.ticket().status_code,503)
                    with self.client.websocket_connect(paths[2]) as third:
                        error=third.receive_json()
                        self.assertEqual(error['type'],'error')
                        self.assertIn('capacity',error['message'])
                        with self.assertRaises(WebSocketDisconnect): third.receive_json()
                    with self.assertRaises(WebSocketDisconnect):
                        with self.client.websocket_connect(paths[2]): pass
                    self.assertEqual(connect.call_count,2)
                    second.send_json({'type':'stop'})
                    with self.assertRaises(WebSocketDisconnect): second.receive_json()
                # Completion releases a slot while the first session is active.
                replacement=self.ticket();self.assertEqual(replacement.status_code,200)
                with self.client.websocket_connect(replacement.json()['websocket_path']) as another:
                    self.assertEqual(another.receive_json()['type'],'ready')
                    another.send_json({'type':'stop'})
                    with self.assertRaises(WebSocketDisconnect): another.receive_json()
                first.send_json({'type':'stop'})
                with self.assertRaises(WebSocketDisconnect): first.receive_json()

    def test_mocked_live_relay_hides_key_and_forwards_bounded_protocol(self):
        class Connection:
            def __init__(self): self.sent=[]; self.delivered=False
            async def __aenter__(self): return self
            async def __aexit__(self, *_): return False
            async def send(self, data): self.sent.append(json.loads(data))
            async def recv(self): return '{"setupComplete":{}}'
            def __aiter__(self): return self
            async def __anext__(self):
                if self.delivered: await asyncio.Future()
                self.delivered=True
                return json.dumps({"serverContent":{"outputTranscription":{"text":"Hello."},
                    "modelTurn":{"parts":[{"inlineData":{"mimeType":"audio/pcm;rate=24000",
                        "data":base64.b64encode(b'\x01\x00').decode()}}]}}})
        upstream=Connection()
        path=self.ticket().json()['websocket_path']
        with patch('websockets.connect', return_value=upstream) as connect:
            with self.client.websocket_connect(path) as client:
                ready=client.receive_json()
                self.assertEqual(ready['type'],'ready')
                client.send_json({'type':'text','text':'Hello there'})
                transcript=client.receive_json(); audio=client.receive_json()
                self.assertEqual(transcript['text'],'Hello.')
                self.assertEqual(audio['type'],'audio')
                self.assertNotIn('unit-test-key',json.dumps([ready,transcript,audio]))
                client.send_json({'type':'stop'})
                with self.assertRaises(WebSocketDisconnect): client.receive_json()
        self.assertNotIn('unit-test-key',connect.call_args.args[0])
        self.assertEqual(connect.call_args.kwargs['additional_headers']['x-goog-api-key'],'unit-test-key')
        self.assertEqual(upstream.sent[0]['setup']['model'],'models/gemini-3.8-live')
        self.assertIn({'realtimeInput':{'text':'Hello there'}},upstream.sent)
        self.assertIn({'realtimeInput':{'audioStreamEnd':True}},upstream.sent)


if __name__ == '__main__': unittest.main()
