import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { db } from "../db";
import { ApiError } from "../http";

export const providerSchema = z.enum(["google_calendar", "gmail"]);
export type GoogleProvider = z.infer<typeof providerSchema>;
type Fetcher = typeof fetch;
type Tokens = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
};
type Integration = {
  id: string;
  provider: GoogleProvider;
  status: string;
  credentials_encrypted: string | null;
  expires_at: string | null;
  scopes: string[];
  metadata: Record<string, unknown>;
};
const READ_SCOPES: Record<GoogleProvider, string[]> = {
  google_calendar: [
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/calendar.freebusy",
  ],
  gmail: ["https://www.googleapis.com/auth/gmail.readonly"],
};
const WRITE_SCOPES: Record<GoogleProvider, string[]> = {
  google_calendar: [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.freebusy",
  ],
  gmail: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ],
};
const WRITE_TOOLS = new Set([
  "calendar_create_event",
  "calendar_update_event",
  "calendar_delete_event",
  "gmail_create_draft",
  "gmail_send",
]);
function encryptionKey(): Buffer {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY || "";
  const key = Buffer.from(raw, "base64");
  if (key.byteLength !== 32)
    throw new ApiError(
      503,
      "Connections require a server encryption key. Ask the administrator to configure INTEGRATION_ENCRYPTION_KEY.",
    );
  return key;
}
export function encryptCredential(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}
export function decryptCredential<T>(value: string): T {
  try {
    const [version, iv, tag, ciphertext, ...rest] = value.split(".");
    if (version !== "v1" || rest.length || !iv || !tag || !ciphertext)
      throw new Error("Invalid encrypted value");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8"),
    ) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      503,
      "Stored connection credentials could not be decrypted. Reconnect this service.",
    );
  }
}
export function googleConfigured(): boolean {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    return false;
  try {
    encryptionKey();
    return Boolean(callbackUri());
  } catch {
    return false;
  }
}
function callbackUri(): string {
  const url = new URL(
    process.env.GOOGLE_REDIRECT_URI ||
      "http://127.0.0.1:3000/api/oauth/google/callback",
  );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new ApiError(
      503,
      "Google OAuth requires HTTPS except for local development.",
    );
  if (url.username || url.password || url.hash || url.search)
    throw new ApiError(503, "The OAuth redirect URL is invalid.");
  return url.toString();
}
function assertConfigured() {
  if (!googleConfigured())
    throw new ApiError(
      503,
      "Google connection is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, and INTEGRATION_ENCRYPTION_KEY on the server.",
    );
}

export async function integrationStatuses(userId: string) {
  const rows = (
    await db.query<Integration>(
      "SELECT id,provider,status,expires_at,scopes,metadata FROM integrations WHERE user_id=$1",
      [userId],
    )
  ).rows;
  return (["google_calendar", "gmail"] as const).map((provider) => {
    const existing = rows.find((r) => r.provider === provider);
    const configured = googleConfigured();
    return {
      provider,
      status: !configured
        ? "configuration_required"
        : existing?.status === "connected"
          ? "connected"
          : "not_connected",
      configured,
      scopes: existing?.scopes || [],
      writeEnabled: existing?.metadata?.write_enabled === true,
      message: !configured
        ? "Google OAuth credentials have not been configured."
        : existing?.status === "connected"
          ? "Connected through Google OAuth."
          : "Connect your Google account to authorize access.",
    };
  });
}
export async function beginGoogleConnection(
  userId: string,
  provider: GoogleProvider,
  allowWrites = false,
): Promise<string> {
  assertConfigured();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const stateHash = createHash("sha256").update(state).digest("hex");
  const scopes = allowWrites ? WRITE_SCOPES[provider] : READ_SCOPES[provider];
  await db.query(
    "DELETE FROM oauth_states WHERE expires_at<now() OR (user_id=$1 AND provider=$2)",
    [userId, provider],
  );
  await db.query(
    "INSERT INTO oauth_states(id,user_id,provider,code_verifier,expires_at) VALUES($1,$2,$3,$4,$5)",
    [
      stateHash,
      userId,
      provider,
      encryptCredential({ verifier, allowWrites, redirectUri: callbackUri() }),
      new Date(Date.now() + 10 * 60_000).toISOString(),
    ],
  );
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: callbackUri(),
    response_type: "code",
    scope: scopes.join(" "),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + params;
}
async function tokenRequest(
  params: Record<string, string>,
  fetcher: Fetcher = fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ApiError(502, "Google could not be reached. Please try again.");
  }
  if (!response.ok)
    throw new ApiError(
      response.status === 400 || response.status === 401 ? 401 : 502,
      "Google rejected the connection. Reconnect and verify the OAuth configuration.",
    );
  const data = (await response.json()) as Record<string, unknown>;
  if (typeof data.access_token !== "string")
    throw new ApiError(502, "Google returned an invalid connection response.");
  return data;
}
export async function completeGoogleConnection(
  userId: string,
  state: string,
  code: string,
  fetcher: Fetcher = fetch,
): Promise<GoogleProvider> {
  assertConfigured();
  if (state.length < 20 || state.length > 200 || !code || code.length > 3000)
    throw new ApiError(400, "The OAuth callback is invalid.");
  const stateHash = createHash("sha256").update(state).digest("hex");
  const row = (
    await db.query<{ provider: GoogleProvider; code_verifier: string }>(
      "DELETE FROM oauth_states WHERE id=$1 AND user_id=$2 AND expires_at>now() RETURNING provider,code_verifier",
      [stateHash, userId],
    )
  ).rows[0];
  if (!row)
    throw new ApiError(
      400,
      "This connection attempt expired or was already used. Start again.",
    );
  const saved = decryptCredential<{
    verifier: string;
    allowWrites: boolean;
    redirectUri: string;
  }>(row.code_verifier);
  if (saved.redirectUri !== callbackUri())
    throw new ApiError(
      400,
      "OAuth configuration changed. Start the connection again.",
    );
  const data = await tokenRequest(
    {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: saved.redirectUri,
      grant_type: "authorization_code",
      code_verifier: saved.verifier,
    },
    fetcher,
  );
  const scopes = typeof data.scope === "string" ? data.scope.split(" ") : [];
  const requested = saved.allowWrites
    ? WRITE_SCOPES[row.provider]
    : READ_SCOPES[row.provider];
  if (!requested.every((scope) => scopes.includes(scope)))
    throw new ApiError(
      403,
      "Google did not grant the required permissions. Your existing connection was preserved.",
    );
  const existing = (
    await db.query<Integration>(
      "SELECT credentials_encrypted FROM integrations WHERE user_id=$1 AND provider=$2",
      [userId, row.provider],
    )
  ).rows[0];
  const old = existing?.credentials_encrypted
    ? decryptCredential<Tokens>(existing.credentials_encrypted)
    : undefined;
  const tokens: Tokens = {
    access_token: data.access_token as string,
    ...(typeof data.refresh_token === "string"
      ? { refresh_token: data.refresh_token }
      : old?.refresh_token
        ? { refresh_token: old.refresh_token }
        : {}),
  };
  const expiry = new Date(
    Date.now() +
      Math.max(60, Math.min(Number(data.expires_in) || 3600, 86400)) * 1000,
  ).toISOString();
  await db.query(
    `INSERT INTO integrations(id,user_id,provider,status,scopes,credentials_encrypted,expires_at,metadata) VALUES($1,$2,$3,'connected',$4,$5,$6,$7)
 ON CONFLICT(user_id,provider) DO UPDATE SET status='connected',scopes=EXCLUDED.scopes,credentials_encrypted=EXCLUDED.credentials_encrypted,expires_at=EXCLUDED.expires_at,metadata=EXCLUDED.metadata,updated_at=now()`,
    [
      randomUUID(),
      userId,
      row.provider,
      JSON.stringify(scopes),
      encryptCredential(tokens),
      expiry,
      JSON.stringify({ write_enabled: saved.allowWrites }),
    ],
  );
  await audit(userId, "integration.connect", row.provider, {
    scopes,
    writeEnabled: saved.allowWrites,
  });
  return row.provider;
}
async function audit(
  userId: string,
  action: string,
  provider: string,
  metadata: Record<string, unknown> = {},
) {
  await db.query(
    "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)",
    [
      randomUUID(),
      userId,
      action,
      "integration",
      provider,
      JSON.stringify(metadata),
    ],
  );
}
export async function disconnectGoogle(
  userId: string,
  provider: GoogleProvider,
  fetcher: Fetcher = fetch,
): Promise<{ revoked: boolean }> {
  const integration = (
    await db.query<Integration>(
      "SELECT * FROM integrations WHERE user_id=$1 AND provider=$2",
      [userId, provider],
    )
  ).rows[0];
  let revoked = false;
  if (integration?.credentials_encrypted) {
    try {
      const t = decryptCredential<Tokens>(integration.credentials_encrypted);
      const response = await fetcher("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: t.refresh_token || t.access_token }),
        signal: AbortSignal.timeout(15_000),
      });
      revoked = response.ok;
    } catch {
      /* Local permission is revoked regardless of provider availability. */
    }
  }
  await db.query("DELETE FROM integrations WHERE user_id=$1 AND provider=$2", [
    userId,
    provider,
  ]);
  await db.query("DELETE FROM oauth_states WHERE user_id=$1 AND provider=$2", [
    userId,
    provider,
  ]);
  await audit(userId, "integration.disconnect", provider, {
    providerRevoked: revoked,
  });
  return { revoked };
}
export async function googleAccessToken(
  userId: string,
  provider: GoogleProvider,
  write = false,
  fetcher: Fetcher = fetch,
): Promise<string> {
  assertConfigured();
  const row = (
    await db.query<Integration>(
      "SELECT * FROM integrations WHERE user_id=$1 AND provider=$2",
      [userId, provider],
    )
  ).rows[0];
  if (row?.status !== "connected" || !row.credentials_encrypted)
    throw new ApiError(
      409,
      `Connect ${provider === "gmail" ? "Gmail" : "Google Calendar"} in Connections first.`,
    );
  if (write && row.metadata.write_enabled !== true)
    throw new ApiError(
      403,
      "This connection is read-only. Reconnect with write permissions before approving this action.",
    );
  const tokens = decryptCredential<Tokens>(row.credentials_encrypted);
  if (
    row.expires_at &&
    new Date(row.expires_at).getTime() > Date.now() + 60_000
  )
    return tokens.access_token;
  if (!tokens.refresh_token)
    throw new ApiError(401, "Google access expired. Reconnect this service.");
  const data = await tokenRequest(
    {
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    },
    fetcher,
  );
  tokens.access_token = data.access_token as string;
  if (typeof data.refresh_token === "string")
    tokens.refresh_token = data.refresh_token;
  await db.query(
    "UPDATE integrations SET credentials_encrypted=$1,expires_at=$2,updated_at=now() WHERE user_id=$3 AND provider=$4",
    [
      encryptCredential(tokens),
      new Date(
        Date.now() + (Number(data.expires_in) || 3600) * 1000,
      ).toISOString(),
      userId,
      provider,
    ],
  );
  return tokens.access_token;
}

async function googleRequest(
  token: string,
  url: string,
  init: RequestInit = {},
  fetcher: Fetcher = fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new ApiError(
      502,
      init.method && init.method !== "GET"
        ? "Google did not confirm the result. Check the service before retrying; the action may have completed."
        : "Google could not be reached. Please try again.",
    );
  }
  if (!response.ok) {
    if (response.status === 401)
      throw new ApiError(
        401,
        "Google access expired or was revoked. Reconnect this service.",
      );
    if (response.status === 403)
      throw new ApiError(
        403,
        "Google denied this operation. Review the granted scopes and provider approval.",
      );
    if (response.status === 404)
      throw new ApiError(404, "The requested Google item was not found.");
    if (response.status === 429)
      throw new ApiError(429, "Google rate limit reached. Try again later.");
    throw new ApiError(
      502,
      "Google did not confirm this operation. Check the service before retrying.",
    );
  }
  return response.status === 204
    ? { success: true }
    : ((await response.json()) as Record<string, unknown>);
}

export const eventSchema = z
  .object({
    summary: z.string().trim().min(1).max(300),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    description: z.string().max(8000).optional(),
    timeZone: z.string().max(100).optional(),
  })
  .strict()
  .refine(
    (x) => new Date(x.end) > new Date(x.start),
    "Event end must follow its start.",
  );
const mailSchema = z
  .object({
    to: z.email().max(254),
    subject: z
      .string()
      .max(300)
      .refine((x) => !/[\r\n]/.test(x), "Subject must be one line."),
    body: z.string().min(1).max(50_000),
  })
  .strict();
export class GoogleCalendarAdapter {
  constructor(
    private token: string,
    private fetcher: Fetcher = fetch,
  ) {}
  async list(
    input: {
      query?: string;
      timeMin?: string;
      timeMax?: string;
      maxResults?: number;
    } = {},
  ) {
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.min(input.maxResults || 30, 100)),
      timeMin: input.timeMin || new Date().toISOString(),
    });
    if (input.timeMax) params.set("timeMax", input.timeMax);
    if (input.query) params.set("q", input.query);
    const data = await googleRequest(
      this.token,
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?" +
        params,
      {},
      this.fetcher,
    );
    return {
      events: Array.isArray(data.items) ? data.items : [],
      timeZone: data.timeZone,
    };
  }
  async freeBusy(input: { timeMin: string; timeMax: string }) {
    return googleRequest(
      this.token,
      "https://www.googleapis.com/calendar/v3/freeBusy",
      {
        method: "POST",
        body: JSON.stringify({ ...input, items: [{ id: "primary" }] }),
      },
      this.fetcher,
    );
  }
  async create(input: z.infer<typeof eventSchema>) {
    const item = eventSchema.parse(input);
    return googleRequest(
      this.token,
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      {
        method: "POST",
        body: JSON.stringify({
          summary: item.summary,
          description: item.description,
          start: {
            dateTime: item.start,
            ...(item.timeZone ? { timeZone: item.timeZone } : {}),
          },
          end: {
            dateTime: item.end,
            ...(item.timeZone ? { timeZone: item.timeZone } : {}),
          },
        }),
      },
      this.fetcher,
    );
  }
  async update(input: {
    eventId: string;
    summary?: string;
    description?: string;
    start?: string;
    end?: string;
  }) {
    const parsed = z
      .object({
        eventId: z.string().min(1).max(300),
        summary: z.string().min(1).max(300).optional(),
        description: z.string().max(8000).optional(),
        start: z.iso.datetime({ offset: true }).optional(),
        end: z.iso.datetime({ offset: true }).optional(),
      })
      .strict()
      .parse(input);
    const { eventId, ...fields } = parsed;
    return googleRequest(
      this.token,
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/" +
        encodeURIComponent(eventId),
      {
        method: "PATCH",
        body: JSON.stringify({
          ...fields,
          ...(fields.start ? { start: { dateTime: fields.start } } : {}),
          ...(fields.end ? { end: { dateTime: fields.end } } : {}),
        }),
      },
      this.fetcher,
    );
  }
  async delete(eventId: string) {
    return googleRequest(
      this.token,
      "https://www.googleapis.com/calendar/v3/calendars/primary/events/" +
        encodeURIComponent(eventId),
      { method: "DELETE" },
      this.fetcher,
    );
  }
}
export class GmailAdapter {
  constructor(
    private token: string,
    private fetcher: Fetcher = fetch,
  ) {}
  async search(input: { query: string; maxResults?: number }) {
    const params = new URLSearchParams({
      q: input.query,
      maxResults: String(Math.min(input.maxResults || 15, 30)),
    });
    const data = await googleRequest(
      this.token,
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?" + params,
      {},
      this.fetcher,
    );
    return {
      messages: Array.isArray(data.messages) ? data.messages : [],
      resultSizeEstimate: data.resultSizeEstimate,
    };
  }
  async read(id: string) {
    const data = await googleRequest(
      this.token,
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/" +
        encodeURIComponent(id) +
        "?format=full",
      {},
      this.fetcher,
    );
    // Return bounded readable content, never active HTML or attachment payloads.
    const plain: string[] = [],
      html: string[] = [];
    let visited = 0;
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || ++visited > 60) return;
      const part = value as {
        mimeType?: string;
        body?: { data?: string };
        parts?: unknown[];
      };
      if (
        typeof part.body?.data === "string" &&
        part.body.data.length < 1_000_000
      ) {
        const decoded = Buffer.from(part.body.data, "base64url")
          .toString("utf8")
          .slice(0, 50_000);
        if (part.mimeType === "text/plain") plain.push(decoded);
        else if (part.mimeType === "text/html")
          html.push(
            decoded
              .replace(
                /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
                "",
              )
              .replace(/<[^>]*>/g, " ")
              .replace(/&nbsp;/g, " "),
          );
      }
      if (Array.isArray(part.parts))
        for (const child of part.parts.slice(0, 60)) visit(child);
    };
    visit(data.payload);
    const payload = data.payload as
      | { headers?: { name: string; value: string }[] }
      | undefined;
    const headers = (payload?.headers || [])
      .filter((h) =>
        ["from", "to", "subject", "date"].includes(h.name.toLowerCase()),
      )
      .slice(0, 12)
      .map((h) => ({ name: h.name, value: h.value.slice(0, 1000) }));
    return {
      id: data.id,
      threadId: data.threadId,
      snippet:
        typeof data.snippet === "string" ? data.snippet.slice(0, 1000) : "",
      headers,
      text: (plain.length ? plain : html).join("\n\n").slice(0, 50_000),
      source: "gmail",
      untrustedContent: true,
    };
  }
  private encode(input: z.infer<typeof mailSchema>): string {
    const item = mailSchema.parse(input);
    const subject =
      "=?UTF-8?B?" + Buffer.from(item.subject).toString("base64") + "?=";
    return Buffer.from(
      `To: ${item.to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(item.body).toString("base64")}`,
    ).toString("base64url");
  }
  async draft(input: z.infer<typeof mailSchema>) {
    return googleRequest(
      this.token,
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      {
        method: "POST",
        body: JSON.stringify({ message: { raw: this.encode(input) } }),
      },
      this.fetcher,
    );
  }
  async send(input: z.infer<typeof mailSchema>) {
    return googleRequest(
      this.token,
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      { method: "POST", body: JSON.stringify({ raw: this.encode(input) }) },
      this.fetcher,
    );
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
async function assertApproved(
  userId: string,
  name: string,
  input: unknown,
  approvalId?: string,
) {
  if (!approvalId)
    throw new ApiError(
      403,
      "This action requires an explicit reviewed approval.",
    );
  const approval = (
    await db.query<{ input: unknown }>(
      "SELECT input FROM approval_requests WHERE id=$1 AND user_id=$2 AND tool_name=$3 AND status=$4 AND expires_at>now()",
      [approvalId, userId, name, "executing"],
    )
  ).rows[0];
  if (!approval)
    throw new ApiError(
      403,
      "The action approval is missing, expired, or already used.",
    );
  const expected = Buffer.from(canonical(approval.input));
  const actual = Buffer.from(canonical(input));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new ApiError(403, "The action differs from what was approved.");
}
export async function executeConnectorTool(
  userId: string,
  name: string,
  input: Record<string, unknown>,
  confirmation?: { approvalId: string },
) {
  const write = WRITE_TOOLS.has(name);
  if (write)
    await assertApproved(userId, name, input, confirmation?.approvalId);
  if (name.startsWith("calendar_")) {
    const adapter = new GoogleCalendarAdapter(
      await googleAccessToken(userId, "google_calendar", write),
    );
    switch (name) {
      case "calendar_list_events":
        return adapter.list(
          input as Parameters<GoogleCalendarAdapter["list"]>[0],
        );
      case "calendar_free_busy":
        return adapter.freeBusy({
          timeMin: String(input.start || input.timeMin),
          timeMax: String(input.end || input.timeMax),
        });
      case "calendar_create_event":
        return adapter.create(eventSchema.parse(input));
      case "calendar_update_event":
        return adapter.update(
          input as Parameters<GoogleCalendarAdapter["update"]>[0],
        );
      case "calendar_delete_event":
        return adapter.delete(z.string().min(1).max(300).parse(input.eventId));
    }
  } else if (name.startsWith("gmail_")) {
    const adapter = new GmailAdapter(
      await googleAccessToken(userId, "gmail", write),
    );
    switch (name) {
      case "gmail_search":
        return adapter.search({
          query: z.string().max(1000).parse(input.query),
          maxResults: input.maxResults as number | undefined,
        });
      case "gmail_read":
        return adapter.read(
          z
            .string()
            .min(1)
            .max(300)
            .parse(input.messageId || input.id),
        );
      case "gmail_create_draft":
        return adapter.draft(mailSchema.parse(input));
      case "gmail_send":
        return adapter.send(mailSchema.parse(input));
    }
  }
  throw new ApiError(400, "This connector operation is not supported.");
}
export const calendarListEvents = (
  userId: string,
  input: Record<string, unknown> = {},
) => executeConnectorTool(userId, "calendar_list_events", input);
export const calendarFreeBusy = (
  userId: string,
  input: Record<string, unknown>,
) => executeConnectorTool(userId, "calendar_free_busy", input);
export const calendarCreateEvent = (
  userId: string,
  input: Record<string, unknown>,
  approvalId: string,
) =>
  executeConnectorTool(userId, "calendar_create_event", input, { approvalId });
export const calendarUpdateEvent = (
  userId: string,
  input: Record<string, unknown>,
  approvalId: string,
) =>
  executeConnectorTool(userId, "calendar_update_event", input, { approvalId });
export const calendarDeleteEvent = (
  userId: string,
  input: Record<string, unknown>,
  approvalId: string,
) =>
  executeConnectorTool(userId, "calendar_delete_event", input, { approvalId });
export const gmailSearch = (userId: string, input: Record<string, unknown>) =>
  executeConnectorTool(userId, "gmail_search", input);
export const gmailRead = (userId: string, input: Record<string, unknown>) =>
  executeConnectorTool(userId, "gmail_read", input);
export const gmailCreateDraft = (
  userId: string,
  input: Record<string, unknown>,
  approvalId: string,
) => executeConnectorTool(userId, "gmail_create_draft", input, { approvalId });
export const gmailSend = (
  userId: string,
  input: Record<string, unknown>,
  approvalId: string,
) => executeConnectorTool(userId, "gmail_send", input, { approvalId });
