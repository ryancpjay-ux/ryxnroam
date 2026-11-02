// Fake iOS location helper speaking the same JSON-lines protocol as helpers/ios_location_helper.py.
// Behaviour comes from FAKE_HELPER_MODE: ok | fatal | reject | lose-after-set. SIMULATED — no device.
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const mode = process.env.FAKE_HELPER_MODE ?? "ok";
const logFile = process.env.FAKE_HELPER_LOG;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const note = (s) => logFile && appendFileSync(logFile, `${s}\n`);

note(`start ${process.argv.slice(2).join(" ")}`);
if (mode === "fatal") {
  out({ event: "fatal", error: "DeveloperModeIsNotEnabledError: developer mode is not enabled" });
  process.exit(1);
}
out({ event: "ready", transport: "userspace", pmd3: "fake" });

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  note(`${msg.cmd}${msg.cmd === "set" ? ` ${msg.lat} ${msg.lng}` : ""}`);
  if (msg.cmd === "quit") {
    out({ id: msg.id, ok: true });
    process.exit(0);
  }
  if (mode === "reject" && msg.cmd === "set") return out({ id: msg.id, ok: false, error: "InvalidServiceError: DeveloperDiskImage not mounted" });
  out({ id: msg.id, ok: true });
  if (mode === "lose-after-set" && msg.cmd === "set")
    setTimeout(() => {
      out({ event: "lost", error: "ConnectionTerminatedError: device disconnected" });
      process.exit(3);
    }, 100);
});
rl.on("close", () => {
  note("eof");
  process.exit(0);
});
