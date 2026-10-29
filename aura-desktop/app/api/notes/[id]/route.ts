import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { api, readJson } from "@/lib/http";
import {
  getRecord,
  updateRecord,
  deleteRecord,
} from "@/lib/services/workspace";
type Context = { params: Promise<{ id: string }> };
export const runtime = "nodejs";
export const GET = api<Context>(async (request, context) => {
  const user = await requireUser(request);
  return Response.json({
    item: await getRecord(user.id, "notes", (await context.params).id),
  });
});
export const PATCH = api<Context>(async (request, context) => {
  const user = await requireUser(request);
  return Response.json({
    item: await updateRecord(
      user.id,
      "notes",
      (await context.params).id,
      await readJson(request, z.unknown()),
    ),
  });
});
export const DELETE = api<Context>(async (request, context) => {
  const user = await requireUser(request);
  return Response.json(
    await deleteRecord(user.id, "notes", (await context.params).id),
  );
});
