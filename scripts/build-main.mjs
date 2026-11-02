// Bundles the Electron main process and preload script with esbuild.
import { execFileSync } from "node:child_process";
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");
let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
} catch {
  /* not a git checkout yet */
}

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  external: ["electron", "electron-updater"],
  define: {
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
    __COMMIT__: JSON.stringify(commit),
  },
  logLevel: "info",
};

const targets = [
  { ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main/index.js" },
  // Sandboxed preload: no Node built-ins beyond what Electron allows, so bundle everything.
  { ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload/index.js" },
];

if (watch) {
  for (const t of targets) await (await context(t)).watch();
} else {
  await Promise.all(targets.map((t) => build(t)));
}
