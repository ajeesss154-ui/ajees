import { requireUser } from "@/lib/auth";
import { api, ApiError } from "@/lib/http";
import { db } from "@/lib/db";
import { audit, validateId } from "@/lib/services/workspace";
export const runtime = "nodejs";
export const DELETE = api<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const user = await requireUser(request);
    const id = validateId((await context.params).id);
    await db.transaction(async (tx) => {
      const result = await tx.query(
        "DELETE FROM reminders WHERE user_id=$1 AND id=$2 RETURNING id",
        [user.id, id],
      );
      if (!result.rows[0]) throw new ApiError(404, "Reminder not found.");
      await audit(user.id, "deleted", "reminders", id, {}, tx);
    });
    return Response.json({ ok: true });
  },
);
