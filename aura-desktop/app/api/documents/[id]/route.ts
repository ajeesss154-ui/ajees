import { z } from "zod";
import { requireUser } from "../../../../lib/auth";
import { api } from "../../../../lib/http";
import {
  deleteDocument,
  getDocument,
} from "../../../../lib/services/knowledge";
type Context = { params: Promise<{ id: string }> };
export const GET = api<Context>(async (request, context) => {
  const user = await requireUser(request);
  const { id } = await context.params;
  return Response.json({
    item: await getDocument(user.id, z.uuid().parse(id)),
  });
});
export const DELETE = api<Context>(async (request, context) => {
  const user = await requireUser(request);
  const { id } = await context.params;
  await deleteDocument(user.id, z.uuid().parse(id));
  return Response.json({ success: true });
});
