import { existsSync } from "node:fs";
import { migrate, db } from "../lib/db";

async function main(): Promise<void> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  try {
    await migrate();
    console.log("AURA database migrations applied.");
  } finally {
    await db.close();
  }
}
main().catch(() => {
  console.error(
    "AURA database migration failed. Check the database configuration and migration integrity.",
  );
  process.exitCode = 1;
});
