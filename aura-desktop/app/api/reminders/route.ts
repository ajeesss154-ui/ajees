import { z } from "zod";
import { randomUUID } from "node:crypto";
import { requireUser } from "@/lib/auth";
import { api, readJson, ApiError } from "@/lib/http";
import { db } from "@/lib/db";
import { audit } from "@/lib/services/workspace";
export const runtime = "nodejs";
export const GET = api(async (request) => {
  const user = await requireUser(request);
  return Response.json({
    items: (
      await db.query(
        "SELECT * FROM reminders WHERE user_id=$1 ORDER BY scheduled_at DESC LIMIT 100",
        [user.id],
      )
    ).rows,
    channel: {
      id: "in_app",
      configured: true,
      description:
        "Delivered to the notification inbox. With local storage, delivery runs while the application is open.",
    },
  });
});
export const POST = api(async (request) => {
  const user = await requireUser(request);
  const data = await readJson(
    request,
    z
      .object({
        title: z.string().trim().min(1).max(200),
        scheduled_at: z.string().datetime({ offset: true }),
        task_id: z.string().uuid().nullable().optional(),
        channel: z.literal("in_app").default("in_app"),
      })
      .strict(),
  );
  if (
    data.task_id &&
    !(
      await db.query("SELECT id FROM tasks WHERE user_id=$1 AND id=$2", [
        user.id,
        data.task_id,
      ])
    ).rows[0]
  )
    throw new ApiError(404, "Task not found.");
  const id = randomUUID();
  const item = await db.transaction(async (tx) => {
    const result = await tx.query(
      "INSERT INTO reminders(id,user_id,task_id,title,scheduled_at,channel) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [
        id,
        user.id,
        data.task_id ?? null,
        data.title,
        data.scheduled_at,
        data.channel,
      ],
    );
    await audit(
      user.id,
      "created",
      "reminders",
      id,
      { channel: data.channel },
      tx,
    );
    return result.rows[0];
  });
  return Response.json({ item }, { status: 201 });
});
