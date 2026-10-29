import { requireUser } from "@/lib/auth";
import { api } from "@/lib/http";
import { dashboard } from "@/lib/services/workspace";
export const runtime = "nodejs";
export const GET = api(async (request) => {
  const user = await requireUser(request);
  return Response.json(await dashboard(user.id));
});
