import { z } from "zod";
import { signin, sessionCookie } from "@/lib/auth";
import { api, readJson } from "@/lib/http";
export const runtime = "nodejs";
export const POST = api(async (request) => {
  const body = await readJson(
    request,
    z.object({ email: z.string(), password: z.string() }).strict(),
  );
  const result = await signin(body.email, body.password);
  return Response.json(
    { user: result.user },
    { headers: { "Set-Cookie": sessionCookie(result.token, request) } },
  );
});
