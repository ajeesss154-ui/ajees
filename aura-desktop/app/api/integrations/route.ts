import { requireUser } from "../../../lib/auth";
import { api } from "../../../lib/http";
import { integrationStatuses } from "../../../lib/connectors/google";
export const GET = api(async (request) => {
  const user = await requireUser(request);
  return Response.json({ integrations: await integrationStatuses(user.id) });
});
