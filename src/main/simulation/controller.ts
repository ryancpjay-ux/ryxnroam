import { EventEmitter } from "node:events";
import { buildTimedGpx } from "../../shared/gpx";
import { Polyline, clampSpeed, kmhToMps } from "../../shared/geo";
import type { StartLocationRequest, StartRouteRequest } from "../../shared/ipc";
import type { DeviceInfo, HistoryEntry, LatLng, MovementMode, SimError, SimulationState, Settings } from "../../shared/types";
import type { DeviceAdapter, LocationSession } from "../devices/adapter";
import { logger } from "../log";

const log = logger("simulation");

export interface HistoryRecorder {
  begin(entry: Omit<HistoryEntry, "id" | "endedAt" | "outcome">): string;
  finish(id: string, patch: Partial<HistoryEntry>): void;
}

export interface ControllerDeps {
  getDevice(id: string): DeviceInfo | undefined;
  getAdapter(id: DeviceInfo["adapterId"]): DeviceAdapter | undefined;
  getSettings(): Settings;
  history: HistoryRecorder;
  now?: () => number;
}

export type OpResult = { ok: true } | { ok: false; error: string; code?: string };

const IDLE: SimulationState = {
  phase: "idle",
  kind: null,
  deviceId: null,
  deviceName: null,
  adapterId: null,
  isTest: false,
  appliedPosition: null,
  enginePosition: null,
  targetName: null,
  confirmation: null,
  route: null,
  startedAt: null,
  error: null,
  note: null,
  scheduleId: null,
};

interface RouteRun {
  line: Polyline;
  speedMps: number;
  mode: MovementMode;
  loop: boolean;
  laps: number;
  /** Distance travelled at `clockStart`. */
  baseMeters: number;
  clockStart: number;
  paused: boolean;
  arrived: boolean;
  stops: StartRouteRequest["stops"];
}

/**
 * Owns the single active simulation. Every transition is serialized; `stop`
 * pre-empts whatever is in flight. State is only marked active after the
 * adapter confirmed it, and the confirmation kind travels with the state.
 */
export class SimulationController extends EventEmitter {
  private state: SimulationState = { ...IDLE };
  private session: LocationSession | null = null;
  private sessionDeviceId: string | null = null;
  private run: RouteRun | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private tickAbort: AbortController | null = null;
  private applying = false;
  private lastApplyAt = 0;
  private consecutiveFailures = 0;
  private opAbort: AbortController | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private historyId: string | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ControllerDeps) {
    super();
    this.now = deps.now ?? Date.now;
  }

  getState(): SimulationState {
    return structuredClone(this.state);
  }

  private set(patch: Partial<SimulationState>) {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.getState());
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private resolveDevice(deviceId: string): { device: DeviceInfo; adapter: DeviceAdapter } | { error: string; code: string } {
    const device = this.deps.getDevice(deviceId);
    if (!device) return { error: "That device is not connected.", code: "device-disconnected" };
    if (device.state !== "connected")
      return { error: device.stateDetail || `The device is ${device.state.replace("-", " ")}.`, code: device.state };
    const adapter = this.deps.getAdapter(device.adapterId);
    if (!adapter) return { error: "No integration is available for this device.", code: "unsupported" };
    return { device, adapter };
  }

  private async ensureSession(device: DeviceInfo, adapter: DeviceAdapter): Promise<LocationSession> {
    if (this.session && this.sessionDeviceId === device.id) return this.session;
    if (this.session) await this.teardown(true);
    const session = adapter.openSession(device, this.deps.getSettings());
    session.onLost = (err) => this.handleLost(err);
    this.session = session;
    this.sessionDeviceId = device.id;
    return session;
  }

  startLocation(req: StartLocationRequest, meta: { scheduleId?: string } = {}): Promise<OpResult> {
    this.opAbort?.abort();
    return this.enqueue(async () => {
      const r = this.resolveDevice(req.deviceId);
      if ("error" in r) return { ok: false, error: r.error, code: r.code };
      const { device, adapter } = r;
      const abort = (this.opAbort = new AbortController());
      const switching = this.sessionDeviceId !== device.id || this.state.kind === "route";
      this.stopEngine();
      if (switching && this.session) await this.teardown(true);
      this.set({
        ...IDLE,
        phase: "starting",
        kind: "location",
        deviceId: device.id,
        deviceName: device.name,
        adapterId: device.adapterId,
        isTest: !!device.isTest,
        enginePosition: req.point,
        appliedPosition: switching ? null : this.state.appliedPosition,
        targetName: req.name ?? null,
        scheduleId: meta.scheduleId ?? null,
      });
      let session: LocationSession;
      try {
        session = await this.ensureSession(device, adapter);
      } catch (e) {
        return this.fail({ code: "internal", message: (e as Error).message });
      }
      const res = await session.apply(req.point, abort.signal);
      if (abort.signal.aborted) return { ok: false, error: "Cancelled.", code: "cancelled" };
      if (!res.ok) {
        await this.teardown(false);
        return this.fail(res.error);
      }
      this.finishHistory("stopped");
      this.historyId = this.deps.history.begin({
        kind: "location",
        label: req.name || "Pinned location",
        point: req.point,
        deviceName: device.name,
        adapterId: device.adapterId,
        isTest: !!device.isTest,
        startedAt: this.now(),
        scheduleId: meta.scheduleId,
      });
      this.set({ phase: "active", appliedPosition: req.point, confirmation: res.confirmation, startedAt: this.now() });
      log.info(`Location applied on ${device.name} (${res.confirmation})`);
      return { ok: true };
    });
  }

  startRoute(req: StartRouteRequest, meta: { scheduleId?: string } = {}): Promise<OpResult> {
    this.opAbort?.abort();
    return this.enqueue(async () => {
      const r = this.resolveDevice(req.deviceId);
      if ("error" in r) return { ok: false, error: r.error, code: r.code };
      if (req.geometry.length < 2) return { ok: false, error: "A route needs at least two points.", code: "invalid" };
      const { device, adapter } = r;
      const abort = (this.opAbort = new AbortController());
      this.stopEngine();
      if (this.session && this.sessionDeviceId !== device.id) await this.teardown(true);
      const line = new Polyline(req.geometry);
      const speedMps = kmhToMps(clampSpeed(req.speedKmh));
      this.run = {
        line,
        speedMps,
        mode: req.mode,
        loop: req.loop,
        laps: 0,
        baseMeters: 0,
        clockStart: this.now(),
        paused: false,
        arrived: false,
        stops: req.stops,
      };
      this.set({
        ...IDLE,
        phase: "starting",
        kind: "route",
        deviceId: device.id,
        deviceName: device.name,
        adapterId: device.adapterId,
        isTest: !!device.isTest,
        enginePosition: line.at(0),
        targetName: req.name ?? null,
        route: this.progress(),
        scheduleId: meta.scheduleId ?? null,
      });
      let session: LocationSession;
      try {
        session = await this.ensureSession(device, adapter);
      } catch (e) {
        this.run = null;
        return this.fail({ code: "internal", message: (e as Error).message });
      }
      const res = session.capabilities.playback && session.play
        ? await session.play(this.gpxFrom(0), abort.signal)
        : await session.apply(line.at(0), abort.signal);
      if (abort.signal.aborted) return { ok: false, error: "Cancelled.", code: "cancelled" };
      if (!res.ok) {
        this.run = null;
        await this.teardown(false);
        return this.fail(res.error);
      }
      this.finishHistory("stopped");
      this.historyId = this.deps.history.begin({
        kind: "route",
        label: req.name || "Route",
        point: line.at(0),
        deviceName: device.name,
        adapterId: device.adapterId,
        isTest: !!device.isTest,
        startedAt: this.now(),
        scheduleId: meta.scheduleId,
        distanceMeters: line.length,
      });
      this.run.clockStart = this.now();
      this.lastApplyAt = this.now();
      this.consecutiveFailures = 0;
      this.set({
        phase: "active",
        appliedPosition: session.capabilities.playback ? null : line.at(0),
        confirmation: res.confirmation,
        startedAt: this.now(),
        route: this.progress(),
      });
      this.startEngine();
      return { ok: true };
    });
  }

  pause(): Promise<OpResult> {
    return this.enqueue(async () => {
      const run = this.run;
      if (!run || this.state.phase !== "active" || run.paused || run.arrived)
        return { ok: false, error: "No moving route to pause." };
      const meters = this.traveled();
      run.baseMeters = meters;
      run.paused = true;
      this.stopEngine();
      const pos = run.line.at(meters);
      if (this.session?.capabilities.playback) {
        // Playback can't freeze mid-file: replace it with a held fixed point.
        const abort = (this.opAbort = new AbortController());
        const res = await this.session.apply(pos, abort.signal);
        if (!res.ok) return this.fail(res.error);
        this.set({ appliedPosition: pos, confirmation: res.confirmation });
      }
      this.set({ phase: "paused", enginePosition: pos, route: this.progress() });
      return { ok: true };
    });
  }

  resume(): Promise<OpResult> {
    return this.enqueue(async () => {
      const run = this.run;
      if (!run || this.state.phase !== "paused") return { ok: false, error: "Nothing is paused." };
      run.paused = false;
      run.clockStart = this.now();
      if (this.session?.capabilities.playback && this.session.play) {
        const abort = (this.opAbort = new AbortController());
        const res = await this.session.play(this.gpxFrom(run.baseMeters), abort.signal);
        if (!res.ok) return this.fail(res.error);
        this.set({ confirmation: res.confirmation });
        run.clockStart = this.now();
      }
      this.set({ phase: "active", route: this.progress() });
      this.startEngine();
      return { ok: true };
    });
  }

  setSpeed(kmh: number, mode: MovementMode): Promise<OpResult> {
    return this.enqueue(async () => {
      const run = this.run;
      if (!run) return { ok: false, error: "No route is running." };
      run.baseMeters = this.traveled();
      run.clockStart = this.now();
      run.speedMps = kmhToMps(clampSpeed(kmh));
      run.mode = mode;
      if (!run.paused && !run.arrived && this.session?.capabilities.playback && this.session.play) {
        const abort = (this.opAbort = new AbortController());
        const res = await this.session.play(this.gpxFrom(run.baseMeters), abort.signal);
        if (!res.ok) return this.fail(res.error);
        run.clockStart = this.now();
      }
      this.set({ route: this.progress() });
      return { ok: true };
    });
  }

  stop(): Promise<OpResult> {
    this.opAbort?.abort();
    return this.enqueue(async () => {
      if (this.state.phase === "idle" && !this.session) return { ok: true };
      if (this.state.phase === "failed" && !this.session) {
        this.set({ ...IDLE });
        return { ok: true };
      }
      this.stopEngine();
      this.set({ phase: "stopping" });
      const session = this.session;
      const device = this.state.deviceId ? this.deps.getDevice(this.state.deviceId) : undefined;
      let note: string | null = null;
      if (session) {
        const res = await session.clear();
        await this.teardown(false);
        if (!res.ok) {
          this.finishHistory("failed", res.error.message);
          return this.fail(
            { ...res.error, message: `Could not restore the device location: ${res.error.message}` },
            false,
          );
        }
        if (!session.capabilities.restoresOnClear)
          note = `${device?.name ?? "The emulator"} keeps its last position — emulators have no real GPS to return to.`;
        else if (this.state.adapterId === "ios-device")
          // iOS's automatic time zone follows location and doesn't always switch back on its own.
          note = `Location restored on ${this.state.deviceName ?? "the device"}. If its clock moved to another time zone, turn Settings › General › Date & Time › Set Automatically off and on.`;
      }
      this.finishHistory(this.run?.arrived ? "completed" : "stopped");
      this.run = null;
      this.set({ ...IDLE, note });
      return { ok: true };
    });
  }

  dismissError() {
    if (this.state.phase === "failed") this.set({ ...IDLE });
    else if (this.state.note) this.set({ note: null });
  }

  /** Called by the device manager when a device vanishes. */
  deviceLost(deviceId: string) {
    if (this.state.deviceId === deviceId && this.state.phase !== "idle" && this.state.phase !== "failed")
      this.handleLost({
        code: "device-disconnected",
        message: `${this.state.deviceName ?? "The device"} disconnected during simulation.`,
        detail: "No location could be applied or cleared. Reconnect the device and check its location.",
      });
  }

  private handleLost(error: SimError) {
    this.opAbort?.abort();
    void this.enqueue(async () => {
      if (this.state.phase === "idle" || this.state.phase === "failed") return;
      this.stopEngine();
      await this.teardown(false);
      this.fail(error);
    });
  }

  private fail(error: SimError, record = true): OpResult {
    this.stopEngine();
    if (record) this.finishHistory("failed", error.message);
    this.run = null;
    log.warn(`Simulation failed: ${error.message}${error.detail ? ` — ${error.detail}` : ""}`);
    this.set({ phase: "failed", error, confirmation: null });
    return { ok: false, error: error.message, code: error.code };
  }

  private finishHistory(outcome: HistoryEntry["outcome"], error?: string) {
    if (!this.historyId) return;
    this.deps.history.finish(this.historyId, {
      outcome,
      endedAt: this.now(),
      error,
      point: this.state.appliedPosition ?? this.state.enginePosition ?? undefined,
    });
    this.historyId = null;
  }

  private async teardown(clear: boolean) {
    const session = this.session;
    this.session = null;
    this.sessionDeviceId = null;
    if (!session) return;
    session.onLost = null;
    if (clear) await session.clear().catch(() => undefined);
    await session.dispose().catch(() => undefined);
  }

  // ---------------------------------------------------------------- engine

  private traveled(): number {
    const run = this.run;
    if (!run) return 0;
    if (run.paused || run.arrived) return run.baseMeters;
    return run.baseMeters + ((this.now() - run.clockStart) / 1000) * run.speedMps;
  }

  private progress(): SimulationState["route"] {
    const run = this.run;
    if (!run) return null;
    const total = run.line.length;
    const traveled = Math.min(total, this.traveled());
    const remainingMs = run.speedMps > 0 ? ((total - traveled) / run.speedMps) * 1000 : 0;
    return {
      totalMeters: total,
      traveledMeters: traveled,
      speedMps: run.speedMps,
      mode: run.mode,
      progress: total > 0 ? traveled / total : 1,
      remainingMs,
      etaAt: run.paused || run.arrived ? null : this.now() + remainingMs,
      loop: run.loop,
      laps: run.laps,
      stops: run.stops,
      geometry: run.line.points,
    };
  }

  private gpxFrom(meters: number): string {
    const run = this.run!;
    return buildTimedGpx(run.line.sliceFrom(meters), run.speedMps, new Date(this.now()));
  }

  private startEngine() {
    this.stopEngine();
    const interval = this.deps.getSettings().location.updateIntervalMs;
    this.tickAbort = new AbortController();
    this.ticker = setInterval(() => this.tick(), interval);
  }

  private stopEngine() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.tickAbort?.abort();
    this.tickAbort = null;
    this.applying = false;
  }

  private tick() {
    const run = this.run;
    if (!run || run.paused || this.state.phase !== "active") return;
    let meters = this.traveled();
    if (meters >= run.line.length) {
      if (run.loop) {
        run.laps += 1;
        meters = meters % Math.max(1, run.line.length);
        run.baseMeters = meters;
        run.clockStart = this.now();
        if (this.session?.capabilities.playback && this.session.play) {
          void this.enqueue(async () => {
            const abort = (this.opAbort = new AbortController());
            const res = await this.session!.play!(this.gpxFrom(run.baseMeters), abort.signal);
            if (!res.ok) this.fail(res.error);
            else run.clockStart = this.now();
          });
        }
      } else {
        run.baseMeters = run.line.length;
        run.arrived = true;
        meters = run.line.length;
        this.finishHistory("completed");
      }
    }
    const pos = run.line.at(meters);
    this.set({ enginePosition: pos, route: this.progress() });
    if (run.arrived) this.stopEngine();
    const session = this.session;
    if (!session || session.capabilities.playback || !session.capabilities.continuous) return;
    if (this.applying && !run.arrived) return;
    if (!run.arrived && this.now() - this.lastApplyAt < session.capabilities.minIntervalMs) return;
    this.applying = true;
    this.lastApplyAt = this.now();
    const signal = this.tickAbort?.signal ?? new AbortController().signal;
    void session
      .apply(pos, signal)
      .then((res) => {
        if (signal.aborted || this.session !== session) return;
        if (res.ok) {
          this.consecutiveFailures = 0;
          this.set({ appliedPosition: pos, confirmation: res.confirmation });
        } else if (res.error.code === "device-disconnected" || ++this.consecutiveFailures >= 3) {
          this.handleLost(res.error);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.session === session) this.applying = false;
      });
  }

  /** Stop everything on quit, restoring device locations when possible. */
  async shutdown(timeoutMs = 8000): Promise<void> {
    await Promise.race([this.stop(), new Promise((r) => setTimeout(r, timeoutMs))]);
    this.stopEngine();
    await this.teardown(false);
  }

  get isRunning(): boolean {
    return this.state.phase !== "idle" && this.state.phase !== "failed";
  }

  currentPosition(): LatLng | null {
    return this.state.appliedPosition ?? this.state.enginePosition;
  }
}
