import { signout, sessionToken, expiredSessionCookie } from "@/lib/auth";
import { api } from "@/lib/http";
export const runtime = "nodejs";
export const POST = api(async (request) => {
  await signout(await sessionToken(request));
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": expiredSessionCookie(request) } },
  );
});
