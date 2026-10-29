import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import type { User } from "./contracts";
import { ApiError } from "./http";

export const SESSION_COOKIE = "aura_session";
const SESSION_DAYS = 30;
const emailSchema = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
const passwordSchema = z
  .string()
  .min(10, "Use a password with at least 10 characters.")
  .max(200);
const nameSchema = z.string().trim().min(1).max(100);
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  passwordSchema.parse(password);
  const salt = randomBytes(16);
  return `scrypt$v1$${salt.toString("base64url")}$${(await derive(password, salt)).toString("base64url")}`;
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  if (password.length > 200) return false;
  const [algorithm, version, saltValue, keyValue, extra] =
    encodedHash.split("$");
  if (
    algorithm !== "scrypt" ||
    version !== "v1" ||
    !saltValue ||
    !keyValue ||
    extra
  )
    return false;
  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(keyValue, "base64url");
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = await derive(password, salt);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Database-backed atomic counters also work with several PostgreSQL app workers. */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const digest = createHash("sha256").update(key).digest("hex");
  const result = await db.query<{ count: number }>(
    `INSERT INTO rate_limits (key, count, window_start) VALUES ($1, 1, now())
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < now() - ($2::int * interval '1 second') THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - ($2::int * interval '1 second') THEN now() ELSE rate_limits.window_start END
     RETURNING count`,
    [digest, windowSeconds],
  );
  if (result.rows[0].count > limit)
    throw new ApiError(429, "Too many attempts. Please wait and try again.");
}

function credentials(
  email: string,
  password: string,
): { email: string; password: string } {
  const parsedEmail = emailSchema.safeParse(email);
  const parsedPassword = passwordSchema.safeParse(password);
  if (!parsedEmail.success || !parsedPassword.success) {
    throw new ApiError(
      400,
      !parsedPassword.success
        ? "Use a password with 10–200 characters."
        : "Enter a valid email address.",
    );
  }
  return { email: parsedEmail.data, password: parsedPassword.data };
}

export async function signup(
  email: string,
  password: string,
  name: string,
): Promise<{ user: User; token: string }> {
  const input = credentials(email, password);
  const parsedName = nameSchema.safeParse(name);
  if (!parsedName.success)
    throw new ApiError(400, "Enter your name (up to 100 characters).");
  await rateLimit(`signup:${input.email}`, 5, 3600);
  // A global cap prevents unbounded expensive password hashes from arbitrary emails.
  await rateLimit("signup:global", 100, 3600);
  const user: User = {
    id: randomUUID(),
    email: input.email,
    name: parsedName.data,
  };
  const passwordHash = await hashPassword(input.password);
  const token = randomBytes(32).toString("base64url");
  try {
    await db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO users (id,email,name,password_hash) VALUES ($1,$2,$3,$4)",
        [user.id, user.email, user.name, passwordHash],
      );
      await tx.query("INSERT INTO user_settings (user_id) VALUES ($1)", [
        user.id,
      ]);
      await tx.query(
        "INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)",
        [
          randomUUID(),
          user.id,
          hashToken(token),
          new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(),
        ],
      );
      await tx.query(
        "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), user.id, "account.created", "user", user.id],
      );
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      throw new ApiError(409, "An account already uses this email.");
    }
    throw error;
  }
  return { user, token };
}

// Nonexistent users still incur the same password derivation cost.
let dummyHash: Promise<string> | undefined;
export async function signin(
  email: string,
  password: string,
): Promise<{ user: User; token: string }> {
  const input = credentials(email, password);
  await rateLimit(`signin:${input.email}`, 10, 900);
  await rateLimit("signin:global", 300, 900);
  const result = await db.query<User & { password_hash: string }>(
    "SELECT id,email,name,password_hash FROM users WHERE email=$1",
    [input.email],
  );
  const row = result.rows[0];
  dummyHash ??= hashPassword("never-a-real-account-password");
  const matches = await verifyPassword(
    input.password,
    row?.password_hash ?? (await dummyHash),
  );
  if (!row || !matches)
    throw new ApiError(401, "Email or password is incorrect.");
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.query(
      "INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)",
      [
        randomUUID(),
        row.id,
        hashToken(token),
        new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(),
      ],
    );
    await tx.query(
      "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), row.id, "session.created", "user", row.id],
    );
  });
  return { user: { id: row.id, email: row.email, name: row.name }, token };
}

function tokenFromRequest(request: Request): string | undefined {
  const cookie = request.headers.get("cookie");
  const pair = cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  if (!pair) return;
  try {
    return decodeURIComponent(pair.slice(SESSION_COOKIE.length + 1));
  } catch {
    return;
  }
}

export async function sessionToken(
  request?: Request,
): Promise<string | undefined> {
  if (request) return tokenFromRequest(request);
  const { cookies } = await import("next/headers");
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function getUser(request?: Request): Promise<User | null> {
  const token = await sessionToken(request);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const result = await db.query<User>(
    `SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at>now()`,
    [hashToken(token)],
  );
  return result.rows[0] ?? null;
}

export async function requireUser(request?: Request): Promise<User> {
  const user = await getUser(request);
  if (!user) throw new ApiError(401, "Please sign in to continue.");
  return user;
}

export async function signout(token?: string): Promise<void> {
  if (!token) return;
  await db.transaction(async (tx) => {
    const result = await tx.query<{ id: string; user_id: string }>(
      "DELETE FROM sessions WHERE token_hash=$1 RETURNING id,user_id",
      [hashToken(token)],
    );
    const session = result.rows[0];
    if (session)
      await tx.query(
        "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id) VALUES($1,$2,$3,$4,$5)",
        [
          randomUUID(),
          session.user_id,
          "session.revoked",
          "session",
          session.id,
        ],
      );
  });
}

function secureCookie(request?: Request): boolean {
  if (process.env.NODE_ENV !== "production") return false;
  // Next may report an internal loopback URL behind a public reverse proxy.
  // A configured canonical origin wins; otherwise use the browser Host authority.
  try {
    const url = process.env.AURA_APP_ORIGIN
      ? new URL(process.env.AURA_APP_ORIGIN)
      : request
        ? new URL(
            `${new URL(request.url).protocol}//${request.headers.get("host") || new URL(request.url).host}`,
          )
        : undefined;
    return !(
      url &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return true;
  }
}
export function sessionCookie(token: string, request?: Request): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secureCookie(request) ? "; Secure" : ""}`;
}
export function expiredSessionCookie(request?: Request): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie(request) ? "; Secure" : ""}`;
}
