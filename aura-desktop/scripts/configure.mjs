import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { readFile, writeFile } from "node:fs/promises";
let hidden = false;
const output = new Writable({
  write(chunk, _encoding, callback) {
    if (!hidden) process.stdout.write(chunk);
    callback();
  },
});
const terminal = createInterface({
  input: process.stdin,
  output,
  terminal: process.stdin.isTTY,
});
try {
  console.log(
    "Configure AURA server-side AI. Provider keys are never sent to the browser.",
  );
  const answer = await terminal.question("Provider: 1 Gemini, 2 OpenAI [1]: ");
  const provider = answer.trim() === "2" ? "openai" : "gemini";
  process.stdout.write(`Paste your ${provider} API key (hidden): `);
  hidden = true;
  const key = (await terminal.question("")).trim();
  hidden = false;
  process.stdout.write("\n");
  if (!key || /[\r\n\x00]/.test(key))
    throw new Error("A nonempty API key is required.");
  let env;
  try {
    env = await readFile(".env.local", "utf8");
  } catch {
    env = await readFile(".env.example", "utf8");
  }
  const updates = {
    AI_PROVIDER: provider,
    [provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY"]:
      JSON.stringify(key),
  };
  for (const [name, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^${name}=.*$`, "m");
    env = pattern.test(env)
      ? env.replace(pattern, () => `${name}=${value}`)
      : `${env}\n${name}=${value}\n`;
  }
  await writeFile(".env.local", env, { mode: 0o600 });
  console.log(
    "Saved to ignored .env.local. Restart AURA to apply. No provider call was made.",
  );
} catch {
  console.error(
    "Configuration was not saved. Try again from the application folder.",
  );
  process.exitCode = 1;
} finally {
  terminal.close();
}
