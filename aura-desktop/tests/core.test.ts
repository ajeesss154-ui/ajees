import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../lib/db";
import {
  createRecord,
  updateRecord,
  deleteRecord,
  getRecord,
  listRecords,
  deliverReminders,
  dashboard,
} from "../lib/services/workspace";
process.env.AURA_DATA_DIR = "memory://";
const userA = randomUUID(),
  userB = randomUUID();
before(async () => {
  for (const id of [userA, userB]) {
    await db.query(
      "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
      [id, `${id}@example.test`, "Test account", "not-a-real-password"],
    );
    await db.query("INSERT INTO user_settings(user_id) VALUES($1)", [id]);
  }
});
after(() => db.close());
test("notes persist, search, edit, organize, and delete without crossing owners", async () => {
  const project = await createRecord(userA, "projects", { name: "Research" });
  const note = await createRecord(userA, "notes", {
    title: "Study plan",
    content: "Read about orbital mechanics",
    project_id: project.id,
    tags: ["study"],
  });
  assert.equal(
    (await getRecord(userA, "notes", String(note.id))).content,
    "Read about orbital mechanics",
  );
  assert.equal((await listRecords(userA, "notes", "orbital")).length, 1);
  assert.equal((await listRecords(userB, "notes", "orbital")).length, 0);
  await assert.rejects(
    () => getRecord(userB, "notes", String(note.id)),
    /not found/,
  );
  await updateRecord(userA, "notes", String(note.id), {
    content: "Review gravity",
  });
  assert.equal(
    (await getRecord(userA, "notes", String(note.id))).content,
    "Review gravity",
  );
  await deleteRecord(userA, "projects", String(project.id));
  assert.equal(
    (await getRecord(userA, "notes", String(note.id))).project_id,
    null,
    "project deletion preserves notes",
  );
  await deleteRecord(userA, "notes", String(note.id));
  await assert.rejects(
    () => getRecord(userA, "notes", String(note.id)),
    /not found/,
  );
});
test("tasks change due dates and completion cancels outstanding reminders", async () => {
  const task = await createRecord(userA, "tasks", {
    title: "Prepare report",
    priority: "high",
    due_at: "2030-01-01T15:00:00Z",
    remind_at: "2030-01-01T14:00:00Z",
  });
  let reminders = (
    await db.query("SELECT * FROM reminders WHERE task_id=$1", [task.id])
  ).rows;
  assert.equal(reminders.length, 1);
  const updated = await updateRecord(userA, "tasks", String(task.id), {
    due_at: "2030-01-02T15:00:00Z",
    remind_at: "2030-01-02T14:00:00Z",
  });
  assert.equal(
    new Date(updated.due_at as string).toISOString(),
    "2030-01-02T15:00:00.000Z",
  );
  reminders = (
    await db.query("SELECT * FROM reminders WHERE task_id=$1", [task.id])
  ).rows;
  assert.equal(reminders.length, 1);
  await updateRecord(userA, "tasks", String(task.id), { status: "done" });
  assert.equal(
    (await db.query("SELECT * FROM reminders WHERE task_id=$1", [task.id])).rows
      .length,
    0,
  );
  assert.equal(
    (await getRecord(userA, "tasks", String(task.id))).status,
    "done",
  );
});
test("due reminders deliver actual in-app notifications exactly once", async () => {
  const task = await createRecord(userA, "tasks", {
    title: "Review due item",
    remind_at: new Date(Date.now() - 60000).toISOString(),
  });
  const result = await deliverReminders(userA);
  assert.equal(result.delivered, 1);
  assert.equal((await deliverReminders(userA)).delivered, 0);
  const rows = (
    await db.query<{ title: string; user_id: string }>(
      "SELECT n.title,n.user_id FROM notifications n JOIN reminders r ON n.reminder_id=r.id WHERE r.task_id=$1",
      [task.id],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Review due item");
  assert.equal(rows[0].user_id, userA);
});
test("disabled notifications keep reminders pending and disabled memory refuses new records", async () => {
  await db.query(
    "UPDATE user_settings SET notifications_enabled=false,memory_enabled=false WHERE user_id=$1",
    [userB],
  );
  const task = await createRecord(userB, "tasks", {
    title: "Wait until enabled",
    remind_at: new Date(Date.now() - 60000).toISOString(),
  });
  assert.equal((await deliverReminders(userB)).delivered, 0);
  assert.equal(
    (
      await db.query<{ status: string }>(
        "SELECT status FROM reminders WHERE task_id=$1",
        [task.id],
      )
    ).rows[0].status,
    "pending",
  );
  await assert.rejects(
    () =>
      createRecord(userB, "memories", {
        title: "Should not save",
        content: "Not authorized",
      }),
    /disabled/,
  );
});
test("validation prevents injected fields and cross-user project references", async () => {
  const otherProject = await createRecord(userB, "projects", {
    name: "Private",
  });
  await assert.rejects(
    () =>
      createRecord(userA, "tasks", {
        title: "Wrong owner",
        project_id: otherProject.id,
      }),
    /not found/,
  );
  await assert.rejects(
    () => createRecord(userA, "notes", { title: "Inject", user_id: userB }),
    /Unrecognized key/,
  );
  await assert.rejects(
    () =>
      createRecord(userA, "tasks", {
        title: "Invalid date",
        due_at: "tomorrow",
      }),
    /Invalid/,
  );
  await assert.rejects(
    () =>
      createRecord(userA, "tasks", {
        title: "Invalid status",
        status: "completed",
      }),
    /Invalid/,
  );
});
test("dashboard and audit reflect persisted records, with applied migration checksum", async () => {
  for (let i = 0; i < 7; i++) {
    await createRecord(userA, "notes", {
      title: `Dashboard note ${i}`,
      content: "Persisted note",
    });
    await createRecord(userA, "projects", { name: `Dashboard project ${i}` });
  }
  await createRecord(userA, "tasks", {
    title: "Future reminder",
    remind_at: "2030-06-01T12:00:00Z",
  });
  const data = await dashboard(userA);
  assert.equal(data.stats.total_notes, 7);
  assert.equal(data.notes.length, 5);
  assert.equal(data.stats.total_projects, 7);
  assert.equal(data.projects.length, 6);
  assert.equal(data.stats.pending_reminders, 1);
  assert.ok(Number(data.stats.total_tasks) >= 2);
  assert.ok(Number(data.stats.completed_tasks) >= 1);
  assert.ok(data.tasks.some((task) => task.title === "Review due item"));
  assert.ok(!data.tasks.some((task) => task.title === "Wait until enabled"));
  const events = (
    await db.query<{ action: string }>(
      "SELECT action FROM audit_logs WHERE user_id=$1",
      [userA],
    )
  ).rows;
  assert.ok(events.some((e) => e.action === "created"));
  assert.ok(events.some((e) => e.action === "reminder_delivered"));
  const migration = (
    await db.query<{ checksum: string }>(
      "SELECT checksum FROM schema_migrations WHERE name=$1",
      ["001_initial.sql"],
    )
  ).rows[0];
  assert.match(migration.checksum, /^[a-f0-9]{64}$/);
});
