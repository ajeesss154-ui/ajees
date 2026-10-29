import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { db } from "../lib/db";
import {
  signup,
  signin,
  getUser,
  requireUser,
  signout,
  hashPassword,
  verifyPassword,
  rateLimit,
  sessionCookie,
} from "../lib/auth";
import {
  api,
  ApiError,
  readJson,
  readBoundedBody,
  assertSameOrigin,
} from "../lib/http";
import { z } from "zod";

process.env.AURA_DATA_DIR = "memory://";
after(async () => {
  await db.close();
});
const email = () => `auth-${randomUUID()}@example.test`;
const password = "correct horse battery 42";

test("password hashes are salted, bounded and reject malformed values", async () => {
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("wrong password 42", first), false);
  assert.equal(await verifyPassword(password, "scrypt$v1$bad$bad"), false);
  assert.equal(await verifyPassword("x".repeat(201), first), false);
  assert.equal(first.includes(password), false);
});

test("signup/signin create hashed sessions and scope authenticated identities", async () => {
  const first = await signup(email(), password, "A User");
  const second = await signup(email(), password, "B User");
  assert.notEqual(first.user.id, second.user.id);
  const request = new Request("http://localhost/api/auth/me", {
    headers: { cookie: `aura_session=${first.token}` },
  });
  const user = await requireUser(request);
  assert.equal(user.id, first.user.id);
  const row = (
    await db.query<{ token_hash: string }>(
      "SELECT token_hash FROM sessions WHERE user_id=$1",
      [user.id],
    )
  ).rows[0];
  assert.equal(
    row.token_hash,
    createHash("sha256").update(first.token).digest("hex"),
  );
  assert.notEqual(row.token_hash, first.token);
  assert.equal(
    (await signin(first.user.email.toUpperCase(), password)).user.id,
    user.id,
  );
  await assert.rejects(
    signin(first.user.email, "incorrect password 42"),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  await assert.rejects(
    signup(first.user.email, password, "Duplicate"),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
  await signout(first.token);
  assert.equal(await getUser(request), null);
  assert.equal(
    (
      await requireUser(
        new Request("http://localhost", {
          headers: { cookie: `aura_session=${second.token}` },
        }),
      )
    ).id,
    second.user.id,
  );
});

test("expired and invalid sessions cannot authenticate", async () => {
  const result = await signup(email(), password, "Expiry");
  await db.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
    [result.user.id],
  );
  assert.equal(
    await getUser(
      new Request("http://localhost", {
        headers: { cookie: `aura_session=${result.token}` },
      }),
    ),
    null,
  );
  assert.equal(
    await getUser(
      new Request("http://localhost", {
        headers: { cookie: "aura_session=%not-a-token" },
      }),
    ),
    null,
  );
  await assert.rejects(
    requireUser(new Request("http://localhost")),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  assert.match(sessionCookie("token"), /HttpOnly/);
  assert.match(sessionCookie("token"), /SameSite=Lax/);
});

test("rate limiting persists and resets after its database time window", async () => {
  const key = `test:${randomUUID()}`;
  await rateLimit(key, 2, 60);
  await rateLimit(key, 2, 60);
  await assert.rejects(
    rateLimit(key, 2, 60),
    (error: unknown) => error instanceof ApiError && error.status === 429,
  );
  const digest = createHash("sha256").update(key).digest("hex");
  await db.query(
    "UPDATE rate_limits SET window_start=now()-interval '61 seconds' WHERE key=$1",
    [digest],
  );
  await rateLimit(key, 2, 60);
});

test("HTTP helper enforces same-origin, JSON validation and sanitized errors", async () => {
  assert.throws(
    () =>
      assertSameOrigin(
        new Request("http://localhost/api/notes", {
          method: "POST",
          headers: { origin: "https://evil.example" },
        }),
      ),
    ApiError,
  );
  assert.doesNotThrow(() =>
    assertSameOrigin(
      new Request("http://localhost/api/notes", {
        method: "POST",
        headers: { origin: "http://localhost" },
      }),
    ),
  );
  const schema = z.object({ name: z.string() }).strict();
  assert.deepEqual(
    await readJson(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":"ok"}',
      }),
      schema,
    ),
    { name: "ok" },
  );
  await assert.rejects(
    readJson(
      new Request("http://localhost", {
        method: "POST",
        body: '{"name":"ok"}',
      }),
      schema,
    ),
    ApiError,
  );
  await assert.rejects(
    readJson(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"name":42}',
      }),
      schema,
    ),
    ApiError,
  );
  const handler = api(async () => {
    throw new Error("private credential value");
  });
  const response = await handler(new Request("http://localhost"), undefined);
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes("private credential"), false);
});

test("chunked request bodies are cancelled once the byte limit is reached", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(9));
      controller.enqueue(new Uint8Array(9));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://localhost", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
  await assert.rejects(
    readBoundedBody(request, 10),
    (error: unknown) => error instanceof ApiError && error.status === 413,
  );
  assert.equal(cancelled, true);
});

// Real Next.js reconstructs URLs with an internal host; browser Host stays canonical.
test("origin checks use the browser host authority and reject forwarded or similar origins", () => {
  const request = (origin: string) =>
    new Request("http://localhost:3000/api/notes", {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin,
        "x-forwarded-host": "attacker.example",
      },
    });
  assert.doesNotThrow(() => assertSameOrigin(request("http://127.0.0.1:3000")));
  assert.throws(
    () => assertSameOrigin(request("http://localhost:3000")),
    ApiError,
  );
  assert.throws(
    () => assertSameOrigin(request("http://attacker.example")),
    ApiError,
  );
  assert.throws(
    () => assertSameOrigin(request("http://127.0.0.1:3001")),
    ApiError,
  );
  const previous = process.env.AURA_APP_ORIGIN;
  process.env.AURA_APP_ORIGIN = "https://aura.example";
  try {
    assert.doesNotThrow(() =>
      assertSameOrigin(request("https://aura.example")),
    );
    assert.throws(
      () => assertSameOrigin(request("http://127.0.0.1:3000")),
      ApiError,
    );
  } finally {
    if (previous === undefined) delete process.env.AURA_APP_ORIGIN;
    else process.env.AURA_APP_ORIGIN = previous;
  }
});

test("production cookies distinguish an HTTP PC origin from a public proxy", () => {
  const previousMode = process.env.NODE_ENV,
    previousOrigin = process.env.AURA_APP_ORIGIN;
  Object.assign(process.env, { NODE_ENV: "production" });
  delete process.env.AURA_APP_ORIGIN;
  try {
    assert.doesNotMatch(
      sessionCookie(
        "test",
        new Request("http://localhost:3000", {
          headers: { host: "127.0.0.1:3000" },
        }),
      ),
      /; Secure/,
    );
    assert.match(
      sessionCookie(
        "test",
        new Request("http://localhost:3000", {
          headers: { host: "aura.example" },
        }),
      ),
      /; Secure/,
    );
    process.env.AURA_APP_ORIGIN = "https://aura.example";
    assert.match(
      sessionCookie("test", new Request("http://localhost:3000")),
      /; Secure/,
    );
    process.env.AURA_APP_ORIGIN = "http://127.0.0.1:3000";
    assert.doesNotMatch(
      sessionCookie("test", new Request("http://localhost:3000")),
      /; Secure/,
    );
  } finally {
    if (previousMode === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Object.assign(process.env, { NODE_ENV: previousMode });
    if (previousOrigin === undefined) delete process.env.AURA_APP_ORIGIN;
    else process.env.AURA_APP_ORIGIN = previousOrigin;
  }
});
