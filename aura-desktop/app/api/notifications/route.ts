import { requireUser } from "@/lib/auth";
import { api } from "@/lib/http";
import { db } from "@/lib/db";
import { deliverReminders } from "@/lib/services/workspace";
export const runtime = "nodejs";
export const GET = api(async (request) => {
  const user = await requireUser(request);
  await deliverReminders(user.id);
  return Response.json({
    items: (
      await db.query(
        "SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
        [user.id],
      )
    ).rows,
  });
});
