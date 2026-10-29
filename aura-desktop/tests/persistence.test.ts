import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "../lib/db";

test("embedded PostgreSQL persists records across restarts and rejects migration drift", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aura-persistence-"));
  process.env.AURA_DATA_DIR = dir;
  delete process.env.DATABASE_URL;
  const userId = randomUUID(),
    noteId = randomUUID();
  try {
    await db.query(
      "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
      [userId, "persist@example.test", "Persistent user", "not-a-real-hash"],
    );
    await db.query(
      "INSERT INTO notes(id,user_id,title,content) VALUES($1,$2,$3,$4)",
      [
        noteId,
        userId,
        "Survives restart",
        "Actual persistent PostgreSQL record",
      ],
    );
    await db.close();
    const row = (
      await db.query<{ content: string }>(
        "SELECT content FROM notes WHERE user_id=$1 AND id=$2",
        [userId, noteId],
      )
    ).rows[0];
    assert.equal(row.content, "Actual persistent PostgreSQL record");
    assert.equal(
      (await db.query("SELECT * FROM schema_migrations")).rows.length,
      1,
    );
    await db.query(
      "UPDATE schema_migrations SET checksum='unexpected-drift' WHERE name='001_initial.sql'",
    );
    await db.close();
    await assert.rejects(
      () => db.query("SELECT 1"),
      /Applied migration .* has changed/,
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
