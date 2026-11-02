import type { LogLine } from "../shared/types";

const MAX_LINES = 600;
const lines: LogLine[] = [];

/** In-memory ring buffer surfaced in Settings › Devices › Diagnostics. Never persisted. */
export function log(level: LogLine["level"], scope: string, msg: string): void {
  const line: LogLine = { t: Date.now(), level, scope, msg: msg.slice(0, 2000) };
  lines.push(line);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  if (process.env.ROAM_DEBUG || level === "error") {
    const out = level === "error" ? console.error : console.log;
    out(`[${scope}] ${msg}`);
  }
}

export const logger = (scope: string) => ({
  info: (m: string) => log("info", scope, m),
  warn: (m: string) => log("warn", scope, m),
  error: (m: string) => log("error", scope, m),
});

export function getLogs(): LogLine[] {
  return lines.slice();
}
