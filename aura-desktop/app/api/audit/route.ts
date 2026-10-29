import { requireUser } from "@/lib/auth";
import { api } from "@/lib/http";
import { db } from "@/lib/db";
export const runtime = "nodejs";
export const GET = api(async (request) => {
  const user = await requireUser(request);
  return Response.json({
    items: (
      await db.query(
        "SELECT id,action,entity_type,entity_id,metadata,created_at FROM audit_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",
        [user.id],
      )
    ).rows,
  });
});
