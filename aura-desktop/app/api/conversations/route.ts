import { requireUser } from "@/lib/auth";
import { api } from "@/lib/http";
import { listConversations } from "@/lib/ai/engine";
export const runtime = "nodejs";
export const GET = api(async (request: Request) => {
  const user = await requireUser(request);
  return Response.json({ conversations: await listConversations(user.id) });
});
