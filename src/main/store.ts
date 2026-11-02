import { promises as fs, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { logger } from "./log";

const log = logger("store");

interface Envelope<T> {
  schema: number;
  savedAt: number;
  data: T;
}

/**
 * A small JSON document store. Writes are debounced and atomic (temp file +
 * rename), so a crash mid-write never corrupts the previous copy. A file that
 * fails to parse is kept aside as `*.corrupt-<time>.json` instead of being
 * silently overwritten.
 */
export class JsonStore<T> {
  private data: T;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  readonly file: string;

  constructor(
    dir: string,
    name: string,
    private readonly schema: number,
    private readonly defaults: () => T,
    private readonly sanitize: (raw: unknown, fromSchema: number) => T,
  ) {
    this.file = path.join(dir, `${name}.json`);
    mkdirSync(dir, { recursive: true });
    this.data = this.loadSync();
  }

  private loadSync(): T {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return this.defaults();
    }
    try {
      const env = JSON.parse(text) as Envelope<unknown>;
      const fromSchema = typeof env?.schema === "number" ? env.schema : 0;
      return this.sanitize(env?.data ?? env, fromSchema);
    } catch (e) {
      const aside = this.file.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
      try {
        renameSync(this.file, aside);
      } catch {
        /* ignore */
      }
      log.error(`${path.basename(this.file)} could not be read and was moved to ${path.basename(aside)}: ${String(e)}`);
      return this.defaults();
    }
  }

  get(): T {
    return this.data;
  }

  set(next: T): void {
    this.data = next;
    this.schedule();
  }

  update(fn: (current: T) => T): T {
    this.set(fn(this.data));
    return this.data;
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 150);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const env: Envelope<T> = { schema: this.schema, savedAt: Date.now(), data: this.data };
    const body = JSON.stringify(env, null, 2);
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        await fs.writeFile(tmp, body, "utf8");
        await fs.rename(tmp, this.file);
      } catch (e) {
        log.error(`Failed to save ${path.basename(this.file)}: ${String(e)}`);
      }
    });
    return this.writing;
  }

  /** Synchronous flush for the quit path. */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ schema: this.schema, savedAt: Date.now(), data: this.data }, null, 2));
      renameSync(tmp, this.file);
    } catch (e) {
      log.error(`Failed to save ${path.basename(this.file)} on quit: ${String(e)}`);
    }
  }
}
