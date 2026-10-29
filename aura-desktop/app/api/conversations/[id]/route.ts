import { requireUser } from "@/lib/auth";
import { api } from "@/lib/http";
import { getConversation, deleteConversation } from "@/lib/ai/engine";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export const GET = api<Context>(async (request, context) => {
  const user = await requireUser(request);
  return Response.json(
    await getConversation(user.id, (await context.params).id),
  );
});
export const DELETE = api<Context>(async (request, context) => {
  const user = await requireUser(request);
  return Response.json(
    await deleteConversation(user.id, (await context.params).id),
  );
});
