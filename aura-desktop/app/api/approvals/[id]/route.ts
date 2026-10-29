import { z } from "zod";
import { requireUser, rateLimit } from "@/lib/auth";
import { api, readJson, ApiError } from "@/lib/http";
import { decideApproval } from "@/lib/ai/approvals";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export const POST = api<Context>(async (request, context) => {
  const user = await requireUser(request);
  await rateLimit(`approvals:${user.id}`, 60, 60);
  const id = (await context.params).id;
  if (!z.string().uuid().safeParse(id).success)
    throw new ApiError(400, "A valid approval ID is required.");
  const input = await readJson(
    request,
    z.object({ decision: z.enum(["approve", "reject"]) }).strict(),
  );
  return Response.json(await decideApproval(user.id, id, input.decision));
});
