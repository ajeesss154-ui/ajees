"""AURA browser acceptance checks. All private API replies are explicit test fixtures.

Run a local backend/static server, then:
  AURA_BASE_URL=http://127.0.0.1:8787 AURA_CHROME_BIN=/path/to/chrome python tests/browser_smoke.py

Requires Playwright. No provider API is invoked; /health is the only real API read.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager

from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("AURA_BASE_URL", "http://127.0.0.1:8787").rstrip("/")
CHROME_BIN = os.environ.get("AURA_CHROME_BIN")
TOKEN = "browser-test-token-not-real"
FIXTURE_REPLY = "TEST FIXTURE: this is a mocked model reply, not a live AI response."
CONFIG = {
    "configured": True, "provider": "browser-test-fixture", "model": "fake-model-for-acceptance-tests",
    "capabilities": ["chat", "screen_context", "action_proposals"],
}


def native_mock(*, ai_mode=False, mode_error=False, configure_error=False, action_error=False):
    """Implement the synchronous Android string-return contract without device actions."""
    config = {
        "aiMode": ai_mode, "accessibilityEnabled": False, "microphoneGranted": False,
        "notificationsGranted": False, "platform": "android", "serverUrl": BASE_URL,
        "accessToken": TOKEN,
    }
    return """
    (() => {
      const current = %s;
      window.__nativeCalls = [];
      const record = (method, args) => window.__nativeCalls.push({method,args});
      window.AuraAndroid = {
        getState: () => JSON.stringify(current),
        setAiMode: value => {
          record('setAiMode',[value]);
          if (%s) return JSON.stringify({error:'TEST FIXTURE: notification permission denied.'});
          current.aiMode = value; return JSON.stringify(current);
        },
        configure: (url,token) => {
          record('configure',[url,token]);
          if (%s) return JSON.stringify({error:'TEST FIXTURE: configuration rejected.'});
          current.serverUrl=url; current.accessToken=token; return JSON.stringify(current);
        },
        executeAction: value => {
          record('executeAction',[value]);
          if (%s) return JSON.stringify({error:'TEST FIXTURE: action rejected by Android.'});
          return JSON.stringify({status:'awaiting_approval'});
        },
        stopListening: () => JSON.stringify({status:'stopped'}),
        stopSpeaking: () => JSON.stringify({status:'stopped'}),
        requestMicrophone: () => JSON.stringify(current),
        requestAccessibility: () => JSON.stringify({status:'requested'})
      };
    })();
    """ % (json.dumps(config), json.dumps(mode_error), json.dumps(configure_error), json.dumps(action_error))


@asynccontextmanager
async def fixture_page(browser, *, native=None, chat_handler=None):
    context = await browser.new_context(viewport={"width": 412, "height": 915}, reduced_motion="reduce", locale="en-US")
    page = await context.new_page()
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    requests = []
    await page.add_init_script("""
      sessionStorage.setItem('aura.accessToken', %s);
      localStorage.setItem('aura.serverUrl', %s);
    """ % (json.dumps(TOKEN), json.dumps(BASE_URL)))
    if native:
        await page.add_init_script(native)

    async def mock_config(route):
        assert route.request.headers.get("authorization") == "Bearer " + TOKEN
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(CONFIG))

    async def mock_chat(route):
        assert route.request.headers.get("authorization") == "Bearer " + TOKEN
        payload = route.request.post_data_json
        requests.append(payload)
        if chat_handler:
            await chat_handler(route, payload)
        else:
            await route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "reply": FIXTURE_REPLY, "model": CONFIG["model"], "provider": CONFIG["provider"],
                "proposals": [], "request_id": "test-request-not-real",
            }))

    await page.route("**/v1/config", mock_config)
    await page.route("**/v1/chat", mock_chat)
    await page.goto(BASE_URL, wait_until="networkidle")
    await expect(page.locator("#connection-short")).to_have_text("Connected")
    try:
        yield page, requests
        assert not page_errors, "Browser JS errors: " + repr(page_errors)
    finally:
        await context.close()


async def test_mobile_layout(browser):
    async with fixture_page(browser) as (page, _):
        geometry = await page.evaluate("""() => ({
          width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          height: innerHeight, scrollHeight: document.documentElement.scrollHeight,
          cards: [...document.querySelectorAll('.action-card')].map(e => ({top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom})),
          composerTop: document.querySelector('.composer').getBoundingClientRect().top
        })""")
        assert geometry["scrollWidth"] <= geometry["width"], geometry
        assert geometry["scrollHeight"] <= geometry["height"] + 4, geometry
        assert len(geometry["cards"]) == 3
        assert all(card["top"] >= 0 and card["bottom"] + 8 <= geometry["composerTop"] for card in geometry["cards"]), geometry


async def test_mode_off_prevents_send(browser):
    async with fixture_page(browser) as (page, requests):
        await expect(page.locator("#ai-mode")).to_have_attribute("aria-checked", "false")
        await page.locator("#message-input").fill("Do not send this while AI mode is off")
        await page.locator("#send-button").click()
        await expect(page.locator("#toast")).to_contain_text("Turn on AI mode")
        assert requests == []
        await expect(page.locator("#message-input")).to_have_value("Do not send this while AI mode is off")


async def test_memory_persistence_and_text_rendering(browser):
    async with fixture_page(browser) as (page, requests):
        title = '<img src=x onerror="window.__memoryXss=true">'
        body = '<script>window.__memoryXss=true</script> My explicitly saved thought.'
        await page.locator("#memory-button").click()
        await page.locator("#memory-title").fill(title)
        await page.locator("#memory-body").fill(body)
        await page.locator("#memory-form button[type=submit]").click()
        await expect(page.locator(".memory-item h3")).to_have_text(title)
        await expect(page.locator(".memory-item p")).to_have_text(body)
        assert await page.locator(".memory-item img, .memory-item script").count() == 0
        assert await page.evaluate("window.__memoryXss === undefined")
        await page.reload(wait_until="networkidle")
        await page.locator("#memory-button").click()
        await expect(page.locator(".memory-item h3")).to_have_text(title)
        await expect(page.locator(".memory-item p")).to_have_text(body)
        assert requests == [], "Saving memory must not send it to the AI."
        assert await page.evaluate("localStorage.getItem('aura.accessToken')") is None


async def test_manual_context_is_explicit_and_one_shot(browser):
    async with fixture_page(browser) as (page, requests):
        await page.locator("#ai-mode").click()
        await page.locator("#screen-button").click()
        await page.locator("#manual-context").fill("TEST FIXTURE: one chosen page of private text")
        assert requests == [], "Typing context must not send it automatically."
        await page.locator("#attach-manual-context").click()
        await expect(page.locator("#context-preview")).to_be_visible()
        await page.locator("#message-input").fill("Help me understand this text")
        await page.locator("#send-button").click()
        await expect(page.locator(".message.assistant:not(.thinking)")).to_have_count(1)
        assert requests[0]["context"]["text"] == "TEST FIXTURE: one chosen page of private text"
        assert requests[0]["context"]["source"] == "manual"
        assert requests[0]["ai_mode"] is True
        await expect(page.locator("#context-preview")).to_be_hidden()
        await page.locator("#message-input").fill("A different question")
        await page.locator("#send-button").click()
        await expect(page.locator(".message.assistant:not(.thinking)")).to_have_count(2)
        assert len(requests) == 2 and "context" not in requests[1]


def proposal_reply(proposal_type="home"):
    return {"reply": FIXTURE_REPLY, "model": CONFIG["model"], "provider": CONFIG["provider"], "request_id": "test-action-not-real", "proposals": [{"id": "fixture-action", "type": proposal_type, "label": "TEST FIXTURE: return to the home screen", "arguments": {}}]}


async def test_browser_refuses_phone_action(browser):
    async def chat(route, _):
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(proposal_reply()))
    async with fixture_page(browser, chat_handler=chat) as (page, _):
        await page.locator("#ai-mode").click()
        await page.locator("#message-input").fill("TEST FIXTURE: propose a phone action")
        await page.locator("#send-button").click()
        await expect(page.locator(".proposal")).to_have_count(1)
        await expect(page.locator(".proposal-status")).to_have_text("Nothing happens until you approve.")
        await page.locator(".proposal .primary-button").click()
        await expect(page.locator(".proposal-status")).to_contain_text("requires the Android app. Nothing was executed")
        assert page.url.rstrip("/") == BASE_URL


async def test_native_rejected_mode_stays_off(browser):
    async with fixture_page(browser, native=native_mock(mode_error=True)) as (page, requests):
        await page.locator("#ai-mode").click()
        await expect(page.locator("#ai-mode")).to_have_attribute("aria-checked", "false")
        await expect(page.locator("#toast")).to_contain_text("notification permission denied")
        assert await page.evaluate("window.__nativeCalls.filter(x => x.method === 'setAiMode').length") == 1
        assert requests == []


async def test_native_rejected_settings_preserve_input(browser):
    async with fixture_page(browser, native=native_mock(configure_error=True)) as (page, requests):
        await page.locator("#connection-button").click()
        await page.locator("#server-url").fill("https://new-server.invalid")
        await page.locator("#access-token").fill("new-fixture-token")
        await page.locator("#settings-form button[type=submit]").click()
        await expect(page.locator("#settings-status")).to_contain_text("configuration rejected")
        await expect(page.locator("#server-url")).to_have_value("https://new-server.invalid")
        await expect(page.locator("#access-token")).to_have_value("new-fixture-token")
        await page.locator('[data-close="settings-dialog"]').click()
        await page.locator("#connection-button").click()
        await expect(page.locator("#server-url")).to_have_value(BASE_URL)
        await expect(page.locator("#access-token")).to_have_value(TOKEN)
        assert requests == []


async def test_native_rejected_action_has_truthful_receipt(browser):
    async def chat(route, _):
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(proposal_reply()))
    async with fixture_page(browser, native=native_mock(ai_mode=True, action_error=True), chat_handler=chat) as (page, _):
        await page.locator("#message-input").fill("TEST FIXTURE: propose a phone action")
        await page.locator("#send-button").click()
        await expect(page.locator(".proposal")).to_have_count(1)
        await page.locator(".proposal .primary-button").click()
        await expect(page.locator(".proposal-status")).to_have_text("Not executed: TEST FIXTURE: action rejected by Android.")
        await expect(page.locator(".proposal .primary-button")).to_be_enabled()
        assert await page.evaluate("window.__nativeCalls.filter(x => x.method === 'executeAction').length") == 1


async def test_mode_off_discards_pending_model_output(browser):
    started = asyncio.Event()
    release = asyncio.Event()
    async def chat(route, _):
        started.set()
        await release.wait()
        try:
            await route.fulfill(status=200, content_type="application/json", body=json.dumps({**proposal_reply(), "reply": "TEST FIXTURE: late reply must never appear"}))
        except Exception:
            # An aborted browser fetch may already have disposed its intercepted route.
            pass
    async with fixture_page(browser, chat_handler=chat) as (page, requests):
        await page.locator("#ai-mode").click()
        await page.locator("#message-input").fill("Wait for this fixture reply")
        await page.locator("#send-button").click()
        await asyncio.wait_for(started.wait(), timeout=5)
        await expect(page.locator(".message.thinking")).to_have_count(1)
        await page.locator("#ai-mode").click()
        await expect(page.locator("#ai-mode")).to_have_attribute("aria-checked", "false")
        release.set()
        await page.wait_for_timeout(250)
        assert len(requests) == 1
        assert await page.locator(".message.thinking").count() == 0
        assert await page.get_by_text("TEST FIXTURE: late reply must never appear", exact=True).count() == 0
        assert await page.locator(".proposal").count() == 0
        await expect(page.locator("#context-preview")).to_be_hidden()


TESTS = [
    test_mobile_layout, test_mode_off_prevents_send, test_memory_persistence_and_text_rendering,
    test_manual_context_is_explicit_and_one_shot, test_browser_refuses_phone_action,
    test_native_rejected_mode_stays_off, test_native_rejected_settings_preserve_input,
    test_native_rejected_action_has_truthful_receipt, test_mode_off_discards_pending_model_output,
]


async def main():
    failed = []
    async with async_playwright() as playwright:
        options = {"headless": True, "args": ["--no-sandbox"]}
        if CHROME_BIN:
            options["executable_path"] = CHROME_BIN
        browser = await playwright.chromium.launch(**options)
        try:
            for test in TESTS:
                try:
                    await test(browser)
                    print("PASS", test.__name__, flush=True)
                except Exception as error:
                    failed.append((test.__name__, repr(error)))
                    print("FAIL", test.__name__, repr(error), flush=True)
        finally:
            await browser.close()
    print(f"{len(TESTS) - len(failed)}/{len(TESTS)} browser acceptance checks passed. Private API/model replies were test fixtures.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
