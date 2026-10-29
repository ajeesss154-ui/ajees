import { z } from "zod";
import { signup, sessionCookie } from "@/lib/auth";
import { api, readJson } from "@/lib/http";
export const runtime = "nodejs";
export const POST = api(async (request) => {
  const body = await readJson(
    request,
    z
      .object({ email: z.string(), password: z.string(), name: z.string() })
      .strict(),
  );
  const result = await signup(body.email, body.password, body.name);
  return Response.json(
    { user: result.user },
    {
      status: 201,
      headers: { "Set-Cookie": sessionCookie(result.token, request) },
    },
  );
});
