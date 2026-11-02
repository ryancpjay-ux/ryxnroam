import { EventEmitter } from "node:events";
import type { AdapterStatus, DeviceAction, DeviceInfo, DevicesSnapshot, Settings } from "../../shared/types";
import { logger } from "../log";
import type { DeviceAdapter } from "./adapter";

const log = logger("devices");
const PROBE_TTL_MS = 30_000;

/**
 * Discovers devices across adapters. Scans are serialized (never overlapping),
 * cancellable, and back off while the window is hidden so idle CPU stays low.
 */
export class DeviceManager extends EventEmitter {
  private adapters: DeviceAdapter[];
  private statuses = new Map<string, AdapterStatus>();
  private devices: DeviceInfo[] = [];
  private scanning = false;
  private lastScanAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private abort: AbortController | null = null;
  private pending: Promise<DevicesSnapshot> | null = null;
  private visible = true;
  /** Adapter whose device is in use; keeps being polled while hidden. */
  private pinnedAdapter: string | null = null;
  private disposed = false;

  /**
   * @param discoverOnly when set, only these adapters list devices; others are still
   *   probed so tooling status is reported. Automated tests use it so they can never
   *   reach a real phone or simulator attached to the machine.
   */
  constructor(
    adapters: DeviceAdapter[],
    private getSettings: () => Settings,
    private readonly discoverOnly: ReadonlySet<string> | null = null,
  ) {
    super();
    this.adapters = adapters;
  }

  private activeAdapters(): DeviceAdapter[] {
    const s = this.getSettings();
    return this.adapters.filter((a) => a.id !== "test" || s.devices.showTestAdapter);
  }

  snapshot(): DevicesSnapshot {
    const ids = new Set(this.activeAdapters().map((a) => a.id));
    return {
      devices: this.devices.filter((d) => ids.has(d.adapterId)),
      adapters: [...this.statuses.values()].filter((s) => ids.has(s.adapterId)),
      scanning: this.scanning,
      lastScanAt: this.lastScanAt,
    };
  }

  get(id: string): DeviceInfo | undefined {
    return this.devices.find((d) => d.id === id);
  }

  adapterFor(id: string): DeviceAdapter | undefined {
    return this.adapters.find((a) => a.id === id);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.reschedule();
  }

  pin(adapterId: string | null) {
    this.pinnedAdapter = adapterId;
  }

  start() {
    void this.scan(true);
  }

  /** Force a full rescan including tool probes. */
  refresh(): Promise<DevicesSnapshot> {
    return this.scan(true);
  }

  invalidateProbes() {
    this.statuses.clear();
    void this.scan(true);
  }

  private reschedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed) return;
    const s = this.getSettings();
    if (!s.devices.autoRefresh && !this.pinnedAdapter) return;
    const base = s.devices.refreshIntervalSec * 1000;
    const interval = this.visible ? base : this.pinnedAdapter ? base * 2 : base * 6;
    this.timer = setTimeout(() => void this.scan(false), interval);
  }

  private scan(forceProbe: boolean): Promise<DevicesSnapshot> {
    if (this.pending) return this.pending;
    this.pending = this.doScan(forceProbe).finally(() => {
      this.pending = null;
      this.reschedule();
    });
    return this.pending;
  }

  private async doScan(forceProbe: boolean): Promise<DevicesSnapshot> {
    const settings = this.getSettings();
    this.abort = new AbortController();
    const { signal } = this.abort;
    this.scanning = true;
    this.emitSnapshot();
    const found: DeviceInfo[] = [];
    const adapters = this.activeAdapters().filter(
      (a) => this.visible || forceProbe || a.id === this.pinnedAdapter || this.getSettings().devices.autoRefresh,
    );
    await Promise.all(
      adapters.map(async (adapter) => {
        let status = this.statuses.get(adapter.id);
        if (forceProbe || !status || Date.now() - status.checkedAt > PROBE_TTL_MS) {
          try {
            status = await adapter.probe(settings, signal);
          } catch (e) {
            status = {
              adapterId: adapter.id,
              label: adapter.label,
              platformSupported: adapter.platformSupported(),
              available: false,
              detail: `Tool check failed: ${(e as Error).message}`,
              checkedAt: Date.now(),
            };
          }
          this.statuses.set(adapter.id, status);
        }
        if (!status.available || (this.discoverOnly && !this.discoverOnly.has(adapter.id))) return;
        try {
          found.push(...(await adapter.discover(settings, signal)));
        } catch (e) {
          if (signal.aborted) return;
          const msg = (e as Error).message;
          log.warn(`${adapter.id} discovery failed: ${msg}`);
          this.statuses.set(adapter.id, { ...status, detail: `Discovery failed: ${msg.slice(0, 200)}` });
        }
      }),
    );
    if (!signal.aborted) {
      const before = new Set(this.devices.map((d) => d.id));
      const after = new Set(found.map((d) => d.id));
      for (const d of found) if (!before.has(d.id)) log.info(`Found ${d.name} (${d.adapterId}, ${d.state})`);
      for (const id of before) if (!after.has(id)) this.emit("lost", id);
      this.devices = found;
      this.lastScanAt = Date.now();
    }
    this.scanning = false;
    const snap = this.snapshot();
    this.emit("change", snap);
    return snap;
  }

  private emitSnapshot() {
    this.emit("change", this.snapshot());
  }

  async runAction(deviceId: string, action: DeviceAction["id"]): Promise<string> {
    const device = this.get(deviceId);
    if (!device) throw new Error("That device is no longer connected.");
    const adapter = this.adapterFor(device.adapterId);
    if (!adapter?.runAction) throw new Error("This device has no preparation steps.");
    const msg = await adapter.runAction(device, action, this.getSettings());
    void this.scan(true);
    return msg;
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.abort?.abort();
  }
}
