import { z } from "zod";
import { requireUser, verifyPassword, expiredSessionCookie } from "@/lib/auth";
import { db } from "@/lib/db";
import { api, readJson, ApiError } from "@/lib/http";
import { getSettings, audit } from "@/lib/services/workspace";
const timezone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Use a valid IANA time zone.");
const settingsSchema = z
  .object({
    memory_enabled: z.boolean().optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
    timezone: timezone.optional(),
    notifications_enabled: z.boolean().optional(),
  })
  .strict();
export const runtime = "nodejs";
export const GET = api(async (request) => {
  const user = await requireUser(request);
  return Response.json({ user, settings: await getSettings(user.id) });
});
export const PATCH = api(async (request) => {
  const user = await requireUser(request);
  const data = await readJson(request, settingsSchema);
  const keys = Object.keys(data);
  if (!keys.length) throw new ApiError(400, "Provide a setting to update.");
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE user_settings SET ${keys.map((key, i) => `${key}=$${i + 2}`).join(",")},updated_at=now() WHERE user_id=$1`,
      [user.id, ...Object.values(data)],
    );
    await audit(
      user.id,
      "settings_updated",
      "user_settings",
      user.id,
      { fields: keys },
      tx,
    );
  });
  return Response.json({ user, settings: await getSettings(user.id) });
});
export const DELETE = api(async (request) => {
  const user = await requireUser(request);
  const data = await readJson(
    request,
    z
      .object({
        password: z.string().max(200),
        confirmation: z.literal("DELETE MY ACCOUNT"),
      })
      .strict(),
  );
  const row = (
    await db.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id=$1",
      [user.id],
    )
  ).rows[0];
  if (!row || !(await verifyPassword(data.password, row.password_hash)))
    throw new ApiError(401, "The password is incorrect.");
  await db.query("DELETE FROM users WHERE id=$1", [user.id]);
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": expiredSessionCookie(request) } },
  );
});
