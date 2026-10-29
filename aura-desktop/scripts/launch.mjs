import { spawn } from "node:child_process";
const version = Number(process.versions.node.split(".")[0]);
if (version < 22) {
  console.error("AURA requires Node.js 22 or newer. Install Node.js LTS.");
  process.exit(1);
}
const target = "http://127.0.0.1:3000";
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3000",
  ],
  { stdio: "inherit" },
);
let opened = false;
const poll = setInterval(async () => {
  if (opened) return;
  try {
    const response = await fetch(target);
    if (response.status < 500) {
      opened = true;
      clearInterval(poll);
      console.log(
        `\nAURA is ready: ${target}\nKeep this terminal open. Press Ctrl+C to stop.\n`,
      );
      if (process.platform === "win32")
        spawn("cmd.exe", ["/c", "start", "", target], {
          stdio: "ignore",
        }).unref();
      else if (process.platform === "darwin")
        spawn("open", [target], { stdio: "ignore" }).unref();
    }
  } catch {}
}, 1500);
const stop = () => {
  clearInterval(poll);
  child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => {
  clearInterval(poll);
  process.exit(code || 0);
});
