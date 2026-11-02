export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchFn = (url, init) => fetch(url, init);
let userAgent = "ryxnroam";

/** Use Electron's `net.fetch` in the app (honours system proxy); plain fetch in tests. */
export function configureHttp(fn: FetchFn, ua: string) {
  fetchImpl = fn;
  userAgent = ua;
}

export async function getJson<T>(url: string, opts: { timeoutMs?: number; signal?: AbortSignal; lang?: string } = {}): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 12000);
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const headers: Record<string, string> = { "User-Agent": userAgent, Accept: "application/json" };
    if (opts.lang) headers["Accept-Language"] = opts.lang;
    const res = await fetchImpl(url, { headers, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return (await res.json()) as T;
  } catch (e) {
    if (ctl.signal.aborted && !opts.signal?.aborted) throw new Error(`Request to ${new URL(url).host} timed out`);
    throw e;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Tiny LRU with TTL, keeps repeated lookups off public servers. */
export class TtlCache<V> {
  private map = new Map<string, { v: V; at: number }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}
  get(k: string): V | undefined {
    const hit = this.map.get(k);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.map.delete(k);
      return undefined;
    }
    this.map.delete(k);
    this.map.set(k, hit);
    return hit.v;
  }
  set(k: string, v: V) {
    this.map.set(k, { v, at: Date.now() });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
}

/** Serializes calls to honour "max N requests per second" usage policies. */
export class RateGate {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly minGapMs: number) {}
  wait(): Promise<void> {
    const next = this.chain.then(async () => {
      const gap = this.last + this.minGapMs - Date.now();
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      this.last = Date.now();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}
