import { requireUser } from "@/lib/auth";
import { api, ApiError } from "@/lib/http";
import { db } from "@/lib/db";
import { validateId } from "@/lib/services/workspace";
export const runtime = "nodejs";
export const PATCH = api<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const user = await requireUser(request);
    const id = validateId((await context.params).id);
    const result = await db.query(
      "UPDATE notifications SET read_at=now() WHERE user_id=$1 AND id=$2 RETURNING *",
      [user.id, id],
    );
    if (!result.rows[0]) throw new ApiError(404, "Notification not found.");
    return Response.json({ item: result.rows[0] });
  },
);
