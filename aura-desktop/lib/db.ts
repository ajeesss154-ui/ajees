import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export interface QueryResult<T> {
  rows: T[];
}
export interface QueryClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}
export interface Database extends QueryClient {
  transaction<T>(fn: (tx: QueryClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
// Next development rebuilds modules. A process-global promise prevents competing
// embedded database instances, and preserves the shared serialization queue.
const globalDb = globalThis as typeof globalThis & {
  __auraDatabase?: Promise<Database>;
};
async function migrations() {
  const dir = path.join(process.cwd(), "migrations");
  const files = (await readdir(dir))
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(dir, name), "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}
async function applyMigrations(
  client: QueryClient,
  all: Awaited<ReturnType<typeof migrations>>,
  execute: (sql: string) => Promise<unknown> = (sql) => client.query(sql),
) {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const migration of all) {
    const previous = (
      await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE name=$1",
        [migration.name],
      )
    ).rows[0];
    if (previous) {
      if (previous.checksum !== migration.checksum)
        throw new Error(
          `Applied migration ${migration.name} has changed. Restore it and add a new migration.`,
        );
      continue;
    }
    await execute(migration.sql);
    await client.query(
      "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
      [migration.name, migration.checksum],
    );
  }
}
async function initialize(): Promise<Database> {
  const all = await migrations();
  if (process.env.DATABASE_URL) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      ssl:
        process.env.DATABASE_SSL === "true"
          ? { rejectUnauthorized: true }
          : undefined,
    });
    const transaction = async <T>(fn: (tx: QueryClient) => Promise<T>) => {
      const c: PoolClient = await pool.connect();
      try {
        await c.query("BEGIN");
        const result = await fn({
          query: async <R>(sql: string, params: unknown[] = []) => ({
            rows: (await c.query(sql, params)).rows as R[],
          }),
        });
        await c.query("COMMIT");
        return result;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    };
    try {
      await transaction(async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(8753121)");
        await applyMigrations(tx, all);
      });
    } catch (e) {
      await pool.end();
      throw e;
    }
    return {
      query: async <T>(sql: string, params: unknown[] = []) => ({
        rows: (await pool.query(sql, params)).rows as T[],
      }),
      transaction,
      close: () => pool.end(),
    };
  }
  const dir =
    process.env.AURA_DATA_DIR || path.join(process.cwd(), ".data", "aura-db");
  if (dir !== "memory://") await mkdir(dir, { recursive: true, mode: 0o700 });
  const pg = new PGlite(dir);
  try {
    await pg.transaction(async (tx) => {
      await applyMigrations(
        {
          query: async <T>(sql: string, params: unknown[] = []) => ({
            rows: (await tx.query<T>(sql, params)).rows,
          }),
        },
        all,
        (sql) => tx.exec(sql),
      );
    });
  } catch (e) {
    await pg.close();
    throw e;
  }
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn);
    tail = result.catch(() => {});
    return result;
  }
  return {
    query: async <T>(sql: string, params: unknown[] = []) =>
      serial(async () => ({ rows: (await pg.query<T>(sql, params)).rows })),
    transaction: async <T>(fn: (tx: QueryClient) => Promise<T>) =>
      serial(() =>
        pg.transaction(async (tx) =>
          fn({
            query: async <R>(sql: string, params: unknown[] = []) => ({
              rows: (await tx.query<R>(sql, params)).rows,
            }),
          }),
        ),
      ),
    close: () => pg.close(),
  };
}
export async function getDb(): Promise<Database> {
  return (globalDb.__auraDatabase ??= initialize().catch((e) => {
    globalDb.__auraDatabase = undefined;
    throw e;
  }));
}
export const db: Database = {
  query: async <T>(sql: string, params?: unknown[]) =>
    (await getDb()).query<T>(sql, params),
  transaction: async <T>(fn: (tx: QueryClient) => Promise<T>) =>
    (await getDb()).transaction(fn),
  close: async () => {
    if (globalDb.__auraDatabase) {
      await (await globalDb.__auraDatabase).close();
      globalDb.__auraDatabase = undefined;
    }
  },
};
export async function migrate() {
  await getDb();
}
