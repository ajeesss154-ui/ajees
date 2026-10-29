import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { api, readJson } from "@/lib/http";
import { listRecords, createRecord } from "@/lib/services/workspace";
export const runtime = "nodejs";
export const GET = api(async (request) => {
  const user = await requireUser(request);
  return Response.json({
    items: await listRecords(
      user.id,
      "memories",
      new URL(request.url).searchParams.get("q") || "",
    ),
  });
});
export const POST = api(async (request) => {
  const user = await requireUser(request);
  const data = await readJson(request, z.unknown());
  return Response.json(
    { item: await createRecord(user.id, "memories", data) },
    { status: 201 },
  );
});
