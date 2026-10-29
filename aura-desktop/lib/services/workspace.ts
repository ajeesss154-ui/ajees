import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, type QueryClient } from "../db";
import { ApiError } from "../http";
import type { EntityKind } from "../contracts";

const text = (n: number) => z.string().trim().min(1).max(n);
const nullableId = z.string().uuid().nullable().optional();
const date = z.string().datetime({ offset: true }).nullable().optional();
const schemas = {
  notes: z
    .object({
      title: text(200),
      content: z.string().max(100000).default(""),
      project_id: nullableId,
      tags: z.array(text(40)).max(20).default([]),
    })
    .strict(),
  tasks: z
    .object({
      title: text(200),
      body: z.string().max(20000).default(""),
      status: z.enum(["todo", "in_progress", "done"]).default("todo"),
      priority: z.enum(["low", "medium", "high"]).default("medium"),
      due_at: date,
      remind_at: date,
      project_id: nullableId,
    })
    .strict(),
  projects: z
    .object({ name: text(120), description: z.string().max(10000).default("") })
    .strict(),
  memories: z
    .object({
      title: text(200),
      content: text(10000),
      kind: z.enum(["fact", "preference", "goal", "context"]).default("fact"),
    })
    .strict(),
};
export type RecordData = Record<string, unknown>;
export function validateKind(kind: string): EntityKind {
  if (!Object.hasOwn(schemas, kind))
    throw new ApiError(404, "Collection not found.");
  return kind as EntityKind;
}
export function validateId(id: string) {
  if (!z.string().uuid().safeParse(id).success)
    throw new ApiError(400, "A valid record ID is required.");
  return id;
}
function parseData(kind: EntityKind, data: unknown, partial = false) {
  const result = (partial ? schemas[kind].partial() : schemas[kind]).safeParse(
    data,
  );
  if (!result.success)
    throw new ApiError(
      400,
      result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    );
  if (partial && !Object.keys(result.data).length)
    throw new ApiError(400, "Provide a field to update.");
  return result.data as RecordData;
}
export async function audit(
  userId: string,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: RecordData = {},
  client: QueryClient = db,
) {
  await client.query(
    "INSERT INTO audit_logs(id,user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,$3,$4,$5,$6)",
    [
      randomUUID(),
      userId,
      action,
      entityType,
      entityId,
      JSON.stringify(metadata),
    ],
  );
}
export async function getSettings(userId: string, client: QueryClient = db) {
  const result = await client.query<RecordData>(
    "SELECT memory_enabled,theme,timezone,notifications_enabled FROM user_settings WHERE user_id=$1",
    [userId],
  );
  if (!result.rows[0]) throw new ApiError(404, "User settings not found.");
  return result.rows[0];
}
export async function listRecords(
  userId: string,
  kind: EntityKind,
  search = "",
  client: QueryClient = db,
): Promise<RecordData[]> {
  validateKind(kind);
  let where = "user_id=$1";
  const params: unknown[] = [userId];
  if (search.trim()) {
    params.push("%" + search.trim().slice(0, 200) + "%");
    where +=
      kind === "projects"
        ? ` AND (name ILIKE $2 OR description ILIKE $2)`
        : ` AND (title ILIKE $2 OR ${kind === "tasks" ? "body" : "content"} ILIKE $2)`;
  }
  return (
    await client.query<RecordData>(
      `SELECT * FROM ${kind} WHERE ${where} ORDER BY updated_at DESC,id LIMIT 500`,
      params,
    )
  ).rows;
}
export async function getRecord(
  userId: string,
  kind: EntityKind,
  id: string,
  client: QueryClient = db,
): Promise<RecordData> {
  validateKind(kind);
  validateId(id);
  const row = (
    await client.query<RecordData>(
      `SELECT * FROM ${kind} WHERE user_id=$1 AND id=$2`,
      [userId, id],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, "Record not found.");
  return row;
}
async function checkProject(
  userId: string,
  data: RecordData,
  client: QueryClient,
) {
  if (data.project_id) {
    const result = await client.query(
      "SELECT id FROM projects WHERE user_id=$1 AND id=$2",
      [userId, data.project_id],
    );
    if (!result.rows.length) throw new ApiError(404, "Project not found.");
  }
}
async function synchronizeReminder(
  userId: string,
  task: RecordData,
  client: QueryClient,
) {
  await client.query(
    "DELETE FROM reminders WHERE user_id=$1 AND task_id=$2 AND status='pending'",
    [userId, task.id],
  );
  if (task.remind_at && task.status !== "done") {
    await client.query(
      "INSERT INTO reminders(id,user_id,task_id,title,scheduled_at) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), userId, task.id, task.title, task.remind_at],
    );
  }
}
export async function createRecord(
  userId: string,
  kind: EntityKind,
  input: unknown,
  client?: QueryClient,
): Promise<RecordData> {
  validateKind(kind);
  const data = parseData(kind, input);
  const perform = async (tx: QueryClient) => {
    if (kind === "memories" && !(await getSettings(userId, tx)).memory_enabled)
      throw new ApiError(
        409,
        "Long-term memory is disabled. Enable it in Settings before saving memory.",
      );
    await checkProject(userId, data, tx);
    const keys = Object.keys(data);
    const values = Object.values(data).map((v, i) =>
      keys[i] === "tags" ? JSON.stringify(v) : (v ?? null),
    );
    const id = randomUUID();
    const row = (
      await tx.query<RecordData>(
        `INSERT INTO ${kind}(id,user_id,${keys.join(",")}) VALUES($1,$2,${keys.map((_, i) => "$" + (i + 3)).join(",")}) RETURNING *`,
        [id, userId, ...values],
      )
    ).rows[0];
    if (kind === "tasks") await synchronizeReminder(userId, row, tx);
    await audit(userId, "created", kind, id, {}, tx);
    return row;
  };
  return client ? perform(client) : db.transaction(perform);
}
export async function updateRecord(
  userId: string,
  kind: EntityKind,
  id: string,
  input: unknown,
  client?: QueryClient,
): Promise<RecordData> {
  validateKind(kind);
  validateId(id);
  const data = parseData(kind, input, true);
  const perform = async (tx: QueryClient) => {
    await getRecord(userId, kind, id, tx);
    await checkProject(userId, data, tx);
    const keys = Object.keys(data);
    const values = Object.values(data).map((v, i) =>
      keys[i] === "tags" ? JSON.stringify(v) : (v ?? null),
    );
    const row = (
      await tx.query<RecordData>(
        `UPDATE ${kind} SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(",")},updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING *`,
        [userId, id, ...values],
      )
    ).rows[0];
    if (kind === "tasks") await synchronizeReminder(userId, row, tx);
    await audit(userId, "updated", kind, id, { fields: keys }, tx);
    return row;
  };
  return client ? perform(client) : db.transaction(perform);
}
export async function deleteRecord(
  userId: string,
  kind: EntityKind,
  id: string,
  client?: QueryClient,
) {
  validateKind(kind);
  validateId(id);
  const perform = async (tx: QueryClient) => {
    await getRecord(userId, kind, id, tx);
    if (kind === "projects") {
      await tx.query(
        "UPDATE notes SET project_id=NULL WHERE user_id=$1 AND project_id=$2",
        [userId, id],
      );
      await tx.query(
        "UPDATE tasks SET project_id=NULL WHERE user_id=$1 AND project_id=$2",
        [userId, id],
      );
    }
    await tx.query(`DELETE FROM ${kind} WHERE user_id=$1 AND id=$2`, [
      userId,
      id,
    ]);
    await audit(userId, "deleted", kind, id, {}, tx);
    return { ok: true };
  };
  return client ? perform(client) : db.transaction(perform);
}
export async function deliverReminders(userId?: string) {
  return db.transaction(async (tx) => {
    const p: unknown[] = [];
    const userFilter = userId ? (p.push(userId), " AND r.user_id=$1") : "";
    const due = (
      await tx.query<RecordData>(
        `SELECT r.* FROM reminders r JOIN user_settings s ON s.user_id=r.user_id WHERE r.status='pending' AND r.scheduled_at<=now() AND s.notifications_enabled=true${userFilter} ORDER BY r.scheduled_at LIMIT 100 FOR UPDATE OF r SKIP LOCKED`,
        p,
      )
    ).rows;
    for (const reminder of due) {
      if (reminder.channel !== "in_app") {
        await tx.query(
          "UPDATE reminders SET status='unconfigured' WHERE id=$1",
          [reminder.id],
        );
        continue;
      }
      await tx.query(
        "INSERT INTO notifications(id,user_id,reminder_id,title,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT(reminder_id) DO NOTHING",
        [
          randomUUID(),
          reminder.user_id,
          reminder.id,
          reminder.title,
          "Your scheduled task reminder is due.",
        ],
      );
      await tx.query(
        "UPDATE reminders SET status='delivered',delivered_at=now() WHERE id=$1",
        [reminder.id],
      );
      await audit(
        String(reminder.user_id),
        "reminder_delivered",
        "reminders",
        String(reminder.id),
        { channel: "in_app" },
        tx,
      );
    }
    return { delivered: due.filter((r) => r.channel === "in_app").length };
  });
}
export async function dashboard(userId: string) {
  await deliverReminders(userId);
  const settings = await getSettings(userId);
  const timezone = String(settings.timezone);
  const results = await Promise.all([
    db.query<RecordData>(
      "SELECT * FROM tasks WHERE user_id=$1 AND status!='done' ORDER BY due_at ASC NULLS LAST,priority DESC LIMIT 8",
      [userId],
    ),
    db.query<RecordData>(
      "SELECT * FROM reminders WHERE user_id=$1 AND status='pending' ORDER BY scheduled_at LIMIT 6",
      [userId],
    ),
    db.query<RecordData>(
      "SELECT * FROM notes WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 5",
      [userId],
    ),
    db.query<RecordData>(
      "SELECT * FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 5",
      [userId],
    ),
    db.query<RecordData>(
      "SELECT p.*,count(t.id)::int total_tasks,count(t.id) FILTER(WHERE t.status='done')::int completed_tasks FROM projects p LEFT JOIN tasks t ON t.project_id=p.id AND t.user_id=p.user_id WHERE p.user_id=$1 GROUP BY p.id ORDER BY p.updated_at DESC LIMIT 6",
      [userId],
    ),
    db.query<RecordData>(
      "SELECT count(*)::int total_tasks,count(*) FILTER(WHERE status='done')::int completed_tasks,count(*) FILTER(WHERE status!='done' AND due_at<now())::int overdue_tasks,count(*) FILTER(WHERE status!='done' AND (due_at AT TIME ZONE $2)::date=(now() AT TIME ZONE $2)::date)::int due_today,(SELECT count(*)::int FROM notes WHERE user_id=$1) total_notes,(SELECT count(*)::int FROM projects WHERE user_id=$1) total_projects,(SELECT count(*)::int FROM reminders WHERE user_id=$1 AND status='pending') pending_reminders FROM tasks WHERE user_id=$1",
      [userId, timezone],
    ),
    db.query<RecordData>(
      "SELECT provider,status,scopes,updated_at FROM integrations WHERE user_id=$1",
      [userId],
    ),
  ]);
  const [
    tasks,
    reminders,
    notes,
    conversations,
    projects,
    stats,
    integrations,
  ] = results.map((r) => r.rows);
  const s = stats[0] || {};
  const suggestions: string[] = [];
  if (Number(s.overdue_tasks) > 0)
    suggestions.push(
      `Review ${s.overdue_tasks} overdue task${Number(s.overdue_tasks) === 1 ? "" : "s"}.`,
    );
  if (!notes.length)
    suggestions.push("Capture a note to give your workspace a starting point.");
  if (tasks.length)
    suggestions.push("Ask AURA to help prioritize your open tasks.");
  if (!integrations.length)
    suggestions.push("Review available connections to add authorized context.");
  return {
    tasks,
    reminders,
    notes,
    conversations,
    projects,
    stats: s,
    integrations,
    suggestions,
  };
}
