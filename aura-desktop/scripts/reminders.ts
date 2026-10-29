import { existsSync } from "node:fs";
import { db } from "../lib/db";
import { deliverReminders } from "../lib/services/workspace";

async function main(): Promise<void> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  if (!process.env.DATABASE_URL) {
    console.error(
      "The separate reminder worker requires DATABASE_URL. With embedded PostgreSQL, due reminders are delivered whenever the application is open.",
    );
    process.exitCode = 1;
    return;
  }
  let running = true;
  let wake: (() => void) | undefined;
  const stop = () => {
    running = false;
    wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log("AURA reminder worker started (in-app channel).");
  try {
    while (running) {
      try {
        const result = await deliverReminders();
        if (result.delivered)
          console.log(`Delivered ${result.delivered} in-app reminders.`);
      } catch {
        console.error("Reminder delivery failed; the worker will retry.");
      }
      if (running)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = undefined;
            resolve();
          }, 15000);
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await db.close();
  }
}
main().catch(() => {
  console.error(
    "AURA reminder worker could not start. Check the database configuration.",
  );
  process.exitCode = 1;
});
