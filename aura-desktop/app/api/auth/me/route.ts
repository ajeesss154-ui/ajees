import { requireUser } from "@/lib/auth";
import { api } from "@/lib/http";
export const runtime = "nodejs";
export const GET = api(async (request) =>
  Response.json({ user: await requireUser(request) }),
);
