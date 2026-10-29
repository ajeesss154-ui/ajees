import { requireUser } from "../../../../lib/auth";
import { api } from "../../../../lib/http";
import { searchKnowledge } from "../../../../lib/services/knowledge";
export const GET = api(async (request) => {
  const user = await requireUser(request);
  const q = new URL(request.url).searchParams.get("q") || "";
  return Response.json({ sources: await searchKnowledge(user.id, q) });
});
