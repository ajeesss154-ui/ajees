import { z } from "zod";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Mutations are same-origin; requests from command-line clients may omit Origin. */
export function assertSameOrigin(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return;
  const origin = request.headers.get("origin");
  if (!origin) return;
  // Next can reconstruct request.url using its internal hostname. The browser's
  // Host authority is the actual origin unless a canonical origin is configured.
  // Browsers cannot override Host; do not trust arbitrary forwarded-host headers.
  const url = new URL(request.url);
  let expected = url.origin;
  const authority = request.headers.get("host");
  if (authority) {
    if (!/^[A-Za-z0-9.\[\]:-]+$/.test(authority))
      throw new ApiError(403, "The application host is invalid.");
    try {
      expected = new URL(`${url.protocol}//${authority}`).origin;
    } catch {
      throw new ApiError(403, "The application host is invalid.");
    }
  }
  if (process.env.AURA_APP_ORIGIN) {
    try {
      const canonical = new URL(process.env.AURA_APP_ORIGIN);
      if (
        !["http:", "https:"].includes(canonical.protocol) ||
        canonical.username ||
        canonical.password ||
        canonical.pathname !== "/" ||
        canonical.search ||
        canonical.hash
      )
        throw new Error("Invalid origin");
      expected = canonical.origin;
    } catch {
      throw new ApiError(
        503,
        "The server application origin is not configured correctly.",
      );
    }
  }
  if (origin !== expected)
    throw new ApiError(403, "This request must come from the application.");
}

/** Read before decoding, so chunked uploads cannot allocate an unbounded body. */
export async function readBoundedBody(
  request: Request,
  maxBytes = 1024 * 1024,
): Promise<Uint8Array> {
  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  if (declaredSize > maxBytes)
    throw new ApiError(413, "The request is too large.");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "The request is too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Could not read the request.");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  return bytes;
}

export async function readJson<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "Send a JSON request body.");
  }
  const raw = new TextDecoder().decode(await readBoundedBody(request));
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "The request contains invalid JSON.");
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ApiError(
      400,
      issue
        ? `${issue.path.join(".") || "Input"}: ${issue.message}`
        : "Invalid input.",
    );
  }
  return result.data;
}

export function api<T = unknown>(
  handler: (request: Request, context: T) => Promise<Response> | Response,
) {
  return async (request: Request, context: T): Promise<Response> => {
    try {
      assertSameOrigin(request);
      const response = await handler(request, context);
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      if (error instanceof ApiError) {
        return Response.json(
          { error: error.message, ...(error.code ? { code: error.code } : {}) },
          {
            status: error.status,
            headers: { "Cache-Control": "no-store" },
          },
        );
      }
      if (error instanceof z.ZodError) {
        return Response.json(
          { error: "The submitted data is invalid." },
          { status: 400 },
        );
      }
      // Deliberately avoid logging provider payloads, database values or credential material.
      console.error(
        "AURA request failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      return Response.json(
        { error: "The request could not be completed. Please try again." },
        {
          status: 500,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  };
}
