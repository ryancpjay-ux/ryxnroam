import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "./log";

const log = logger("exec");

/** Every child we start, so quitting the app can never leave orphans behind. */
const children = new Set<ChildProcess>();

let extraPath: string[] = [];

/**
 * GUI apps on macOS inherit a minimal PATH. Ask the user's login shell for
 * theirs once, so user-installed tools (pymobiledevice3, adb) are found
 * exactly as they are in Terminal.
 */
export async function loadShellPath(): Promise<void> {
  const dirs = new Set<string>();
  const home = os.homedir();
  if (process.platform === "darwin" || process.platform === "linux") {
    const shell = process.env.SHELL || "/bin/zsh";
    const marker = "__ROAM_PATH__";
    const res = await run(shell, ["-ilc", `printf '${marker}%s${marker}' "$PATH"`], {
      timeoutMs: 4000,
      quiet: true,
    }).catch(() => null);
    const m = res?.stdout.match(new RegExp(`${marker}(.*)${marker}`));
    if (m) for (const d of m[1].split(":")) if (d) dirs.add(d);
    for (const d of ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local/bin")]) dirs.add(d);
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) dirs.add(path.join(local, "Android", "Sdk", "platform-tools"));
  }
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdk) dirs.add(path.join(sdk, "platform-tools"));
  if (process.platform === "darwin") dirs.add(path.join(home, "Library/Android/sdk/platform-tools"));
  extraPath = [...dirs];
}

export function searchPath(): string[] {
  const base = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return [...new Set([...base, ...extraPath])];
}

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: searchPath().join(path.delimiter), PYTHONUNBUFFERED: "1", ...extra };
}

function isExecutableFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolve an executable by name (or validate an explicit path) without using a shell. */
export function which(nameOrPath: string): string | null {
  if (!nameOrPath) return null;
  if (path.isAbsolute(nameOrPath)) return existsSync(nameOrPath) && isExecutableFile(nameOrPath) ? nameOrPath : null;
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").concat([""]) : [""];
  for (const dir of searchPath()) {
    for (const ext of exts) {
      const candidate = path.join(dir, nameOrPath + ext.toLowerCase());
      if (isExecutableFile(candidate)) return candidate;
      if (ext && isExecutableFile(path.join(dir, nameOrPath + ext))) return path.join(dir, nameOrPath + ext);
    }
  }
  return null;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  input?: string;
  quiet?: boolean;
}

/** Run a command to completion. Never uses a shell; arguments are passed verbatim. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { timeoutMs = 15000, signal, input, quiet } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    if (!quiet) log.info(`$ ${path.basename(cmd)} ${args.join(" ")}`);
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { env: childEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return reject(e);
    }
    children.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s: string, chunk: Buffer) => (s.length > 1_000_000 ? s : s + chunk.toString("utf8"));
    child.stdout?.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr?.on("data", (c: Buffer) => (stderr = cap(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      clearTimeout(timer);
      children.delete(child);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      children.delete(child);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("aborted"));
      resolve({ code, signal: sig, stdout, stderr, timedOut });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

export type JsonMessage = Record<string, unknown>;

/**
 * A long-running helper that speaks one JSON object per line: requests carry an
 * `id` and get a reply with the same id; anything with an `event` field is an
 * unsolicited notification.
 */
export class JsonLineProcess {
  readonly child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, (msg: JsonMessage) => void>();
  private events: JsonMessage[] = [];
  private eventWaiters: (() => void)[] = [];
  private buffer = "";
  private errTail = "";
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private exitWaiters: (() => void)[] = [];
  onEvent: ((msg: JsonMessage) => void) | null = null;
  onExit: ((code: number | null, signal: NodeJS.Signals | null, stderr: string) => void) | null = null;

  constructor(cmd: string, args: string[]) {
    log.info(`$ ${path.basename(cmd)} ${args.map((a) => path.basename(a)).join(" ")}  (helper)`);
    this.child = spawn(cmd, args, { env: childEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    children.add(this.child);
    this.child.stdout?.on("data", (c: Buffer) => {
      this.buffer += c.toString("utf8");
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) this.dispatch(line);
      }
    });
    this.child.stderr?.on("data", (c: Buffer) => {
      this.errTail = (this.errTail + c.toString("utf8")).slice(-4000);
    });
    this.child.on("error", (err) => {
      this.errTail += `\n${err.message}`;
      this.finish(null, null);
    });
    this.child.on("close", (code, sig) => this.finish(code, sig));
    this.child.stdin?.on("error", () => undefined);
  }

  private dispatch(line: string) {
    let msg: JsonMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      this.errTail = (this.errTail + `\n${line}`).slice(-4000);
      return;
    }
    const id = typeof msg.id === "number" ? msg.id : null;
    const reply = id !== null ? this.pending.get(id) : undefined;
    if (reply) {
      this.pending.delete(id!);
      reply(msg);
    } else if (typeof msg.event === "string") {
      this.events.push(msg);
      for (const w of this.eventWaiters.splice(0)) w();
      this.onEvent?.(msg);
    }
  }

  private finish(code: number | null, signal: NodeJS.Signals | null) {
    if (this.exitInfo) return;
    this.exitInfo = { code, signal };
    children.delete(this.child);
    for (const reply of this.pending.values()) reply({ ok: false, error: this.errTail.trim() || "The helper exited." });
    this.pending.clear();
    for (const w of this.exitWaiters.splice(0)) w();
    for (const w of this.eventWaiters.splice(0)) w();
    this.onExit?.(code, signal, this.errTail);
  }

  get exited() {
    return this.exitInfo;
  }

  get stderr(): string {
    return this.errTail;
  }

  /** Send a request; resolves with the reply, or `{ ok: false }` on timeout, abort or exit. */
  request(body: JsonMessage, timeoutMs: number, signal?: AbortSignal): Promise<JsonMessage> {
    if (this.exitInfo) return Promise.resolve({ ok: false, error: this.errTail.trim() || "The helper is not running." });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const done = (msg: JsonMessage) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        resolve(msg);
      };
      const timer = setTimeout(() => done({ ok: false, error: "timeout", timeout: true }), timeoutMs);
      const onAbort = () => done({ ok: false, error: "aborted", aborted: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, done);
      this.child.stdin?.write(`${JSON.stringify({ ...body, id })}\n`);
    });
  }

  /** Wait for the first event whose name is in `names`; null on timeout, abort or exit. */
  waitForEvent(names: string[], timeoutMs: number, signal?: AbortSignal): Promise<JsonMessage | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: JsonMessage | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      };
      const check = () => {
        const hit = this.events.find((e) => names.includes(e.event as string));
        if (hit) return done(hit);
        if (this.exitInfo) return done(null);
        this.eventWaiters.push(check);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      const onAbort = () => done(null);
      signal?.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }

  /** Ask the helper to quit, then force it after `graceMs`. */
  async stop(graceMs = 3000): Promise<void> {
    if (this.exitInfo) return;
    const exited = new Promise<void>((r) => this.exitWaiters.push(r));
    void this.request({ cmd: "quit" }, graceMs);
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), graceMs);
    await exited;
    clearTimeout(timer);
  }
}

/** Kill everything we started. Called on quit as a last line of defence. */
export function killAllChildren(): void {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  children.clear();
}

export function liveChildCount(): number {
  return children.size;
}
