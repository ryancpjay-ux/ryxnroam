// Development: Vite for the renderer, esbuild watch for main/preload, then Electron.
import { spawn } from "node:child_process";
import { createServer } from "vite";

const server = await createServer({ configFile: "vite.config.mts" });
await server.listen();
const url = server.resolvedUrls?.local?.[0] ?? "http://localhost:5173/";

const build = spawn(process.execPath, ["scripts/build-main.mjs"], { stdio: "inherit" });
await new Promise((r) => build.on("exit", r));
const watcher = spawn(process.execPath, ["scripts/build-main.mjs", "--watch"], { stdio: "inherit" });

const electronPath = (await import("electron")).default;
const app = spawn(electronPath, ["."], { stdio: "inherit", env: { ...process.env, ROAM_DEV_URL: url } });

let closing = false;
async function shutdown(code) {
  if (closing) return;
  closing = true;
  watcher.kill();
  if (app.exitCode === null) app.kill("SIGTERM");
  await server.close();
  process.exit(code ?? 0);
}
app.on("exit", (code) => void shutdown(code));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void shutdown(0));
