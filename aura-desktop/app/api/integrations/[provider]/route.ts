import { requireUser } from "../../../../lib/auth";
import { api } from "../../../../lib/http";
import {
  disconnectGoogle,
  providerSchema,
} from "../../../../lib/connectors/google";
type Context = { params: Promise<{ provider: string }> };
export const DELETE = api<Context>(async (request, context) => {
  const user = await requireUser(request);
  const provider = providerSchema.parse((await context.params).provider);
  return Response.json({
    success: true,
    ...(await disconnectGoogle(user.id, provider)),
  });
});
