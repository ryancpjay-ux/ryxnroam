import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { speedKmh } from "../shared/geo";
import type { NewSchedule } from "../shared/ipc";
import type { DeviceInfo, Library, Schedule, Settings, SimulationState } from "../shared/types";
import { logger } from "./log";
import type { SimulationController } from "./simulation/controller";
import { computeRoute } from "./services/routing";
import type { JsonStore } from "./store";

const log = logger("scheduler");
const MISSED_GRACE_MS = 2 * 60_000;
const MAX_TIMEOUT = 2 ** 31 - 1;

export interface SchedulerDeps {
  store: JsonStore<Schedule[]>;
  controller: SimulationController;
  getLibrary(): Library;
  getDevice(id: string): DeviceInfo | undefined;
  getSettings(): Settings;
  notify(title: string, body: string): void;
}

/**
 * Runs scheduled simulations while the app is open. It never reports success
 * it did not observe: a missed start (app closed), a missing device or a
 * rejected command are recorded as such.
 */
export class Scheduler extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: SchedulerDeps) {
    super();
    deps.controller.on("state", (s: SimulationState) => this.observe(s));
  }

  list(): Schedule[] {
    return this.deps.store.get().slice().sort((a, b) => b.startAt - a.startAt);
  }

  private save(next: Schedule[]) {
    this.deps.store.set(next);
    this.emit("change", this.list());
  }

  private patch(id: string, patch: Partial<Schedule>) {
    this.save(this.deps.store.get().map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  start() {
    const now = Date.now();
    let changed = false;
    const next = this.deps.store.get().map((s) => {
      if (s.status === "scheduled" && s.startAt < now - MISSED_GRACE_MS) {
        changed = true;
        return { ...s, status: "missed" as const, outcomeDetail: "ryxnroam was not running at the scheduled time." };
      }
      if (s.status === "running") {
        changed = true;
        return { ...s, status: "failed" as const, finishedAt: now, outcomeDetail: "The app closed while this schedule was running." };
      }
      return s;
    });
    if (changed) this.save(next);
    this.arm();
    // Re-check periodically: timers drift across sleep and clock changes.
    this.heartbeat = setInterval(() => this.arm(), 30_000);
  }

  create(input: NewSchedule): Schedule {
    if (input.consent !== true) throw new Error("Confirm you are authorized to simulate location on this device.");
    if (!Number.isFinite(input.startAt) || input.startAt < Date.now() - 30_000)
      throw new Error("Choose a start time in the future.");
    if (input.durationMinutes !== null && !(input.durationMinutes >= 1 && input.durationMinutes <= 24 * 60))
      throw new Error("Duration must be between 1 minute and 24 hours.");
    const device = this.deps.getDevice(input.deviceId);
    const lib = this.deps.getLibrary();
    const label =
      input.target.kind === "favorite"
        ? lib.favorites.find((f) => f.id === (input.target as { favoriteId: string }).favoriteId)?.name
        : lib.routes.find((r) => r.id === (input.target as { routeId: string }).routeId)?.name;
    if (!label) throw new Error("The selected location or route no longer exists.");
    const schedule: Schedule = {
      id: randomUUID(),
      target: input.target,
      targetLabel: label,
      deviceId: input.deviceId,
      deviceName: device?.name ?? input.deviceId,
      startAt: input.startAt,
      durationMinutes: input.durationMinutes,
      consentAt: Date.now(),
      status: "scheduled",
      createdAt: Date.now(),
    };
    this.save([...this.deps.store.get(), schedule]);
    log.info(`Scheduled “${label}” on ${schedule.deviceName} for ${new Date(schedule.startAt).toISOString()}`);
    this.arm();
    return schedule;
  }

  cancel(id: string) {
    const s = this.deps.store.get().find((x) => x.id === id);
    if (!s) return;
    if (s.status === "running") {
      this.clearStopTimer(id);
      this.patch(id, { status: "cancelled", finishedAt: Date.now(), outcomeDetail: "Cancelled while running; simulation stopped." });
      if (this.deps.controller.getState().scheduleId === id) void this.deps.controller.stop();
    } else if (s.status === "scheduled") {
      this.patch(id, { status: "cancelled", finishedAt: Date.now(), outcomeDetail: "Cancelled before it started." });
    }
    this.arm();
  }

  remove(id: string) {
    const s = this.deps.store.get().find((x) => x.id === id);
    if (s?.status === "running") this.cancel(id);
    this.save(this.deps.store.get().filter((x) => x.id !== id));
  }

  private arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const now = Date.now();
    const due = this.deps.store.get().filter((s) => s.status === "scheduled");
    for (const s of due) if (s.startAt <= now) void this.fire(s.id);
    const next = due.filter((s) => s.startAt > now).sort((a, b) => a.startAt - b.startAt)[0];
    if (next) this.timer = setTimeout(() => this.arm(), Math.min(MAX_TIMEOUT, next.startAt - now));
  }

  private async fire(id: string) {
    const s = this.deps.store.get().find((x) => x.id === id);
    if (!s || s.status !== "scheduled") return;
    if (s.startAt < Date.now() - MISSED_GRACE_MS) {
      return this.finish(id, "missed", "The computer was asleep or the app was busy at the scheduled time.");
    }
    this.patch(id, { status: "running", ranAt: Date.now() });
    const ctl = this.deps.controller;
    if (ctl.isRunning) return this.finish(id, "failed", "Another simulation was active, so the schedule did not override it.");
    const device = this.deps.getDevice(s.deviceId);
    if (!device) return this.finish(id, "failed", `${s.deviceName} was not connected at the start time.`);
    if (device.state !== "connected")
      return this.finish(id, "failed", `${s.deviceName} was not ready: ${device.stateDetail ?? device.state}.`);
    const lib = this.deps.getLibrary();
    let result;
    if (s.target.kind === "favorite") {
      const fid = s.target.favoriteId;
      const fav = lib.favorites.find((f) => f.id === fid);
      if (!fav) return this.finish(id, "failed", "The saved location was deleted.");
      result = await ctl.startLocation({ deviceId: device.id, point: fav.point, name: fav.name }, { scheduleId: id });
    } else {
      const rid = s.target.routeId;
      const route = lib.routes.find((r) => r.id === rid);
      if (!route) return this.finish(id, "failed", "The saved route was deleted.");
      const geometry =
        route.geometry ??
        (await computeRoute(route.stops.map((x) => x.point), route.mode, route.pathMode).catch(() => null))?.geometry;
      if (!geometry) return this.finish(id, "failed", "The route could not be calculated.");
      const settings = this.deps.getSettings();
      result = await ctl.startRoute(
        {
          deviceId: device.id,
          name: route.name,
          stops: route.stops,
          geometry,
          mode: route.mode,
          speedKmh: speedKmh(route.mode, route.customSpeedKmh ?? settings.location.customSpeedKmh),
          loop: route.loop,
        },
        { scheduleId: id },
      );
    }
    if (!result.ok) return this.finish(id, "failed", result.error);
    this.deps.notify("Scheduled simulation started", `${s.targetLabel} on ${s.deviceName}`);
    if (s.durationMinutes) {
      const t = setTimeout(() => void this.endByDuration(id), Math.min(MAX_TIMEOUT, s.durationMinutes * 60_000));
      this.stopTimers.set(id, t);
    } else if (s.target.kind === "favorite") {
      this.finish(id, "completed", "Location applied. It stays active until you stop it.");
    }
  }

  private async endByDuration(id: string) {
    this.stopTimers.delete(id);
    const s = this.deps.store.get().find((x) => x.id === id);
    if (!s || s.status !== "running") return;
    const ctl = this.deps.controller;
    if (ctl.getState().scheduleId !== id) return this.finish(id, "cancelled", "The simulation was replaced before the duration ended.");
    const res = await ctl.stop();
    if (res.ok) this.finish(id, "completed", `Ran for ${s.durationMinutes} min and restored the location.`);
    else this.finish(id, "failed", `Ran for ${s.durationMinutes} min but stopping failed: ${res.error}`);
  }

  private observe(state: SimulationState) {
    const running = this.deps.store.get().filter((s) => s.status === "running");
    for (const s of running) {
      if (state.scheduleId === s.id && state.phase === "failed") {
        this.finish(s.id, "failed", state.error?.message ?? "The simulation failed.");
      } else if (state.scheduleId === s.id && state.kind === "route" && state.route && state.route.progress >= 1 && !s.durationMinutes) {
        this.finish(s.id, "completed", "Route finished. The device holds the destination until you stop.");
      } else if (state.scheduleId !== s.id && (state.phase === "idle" || state.phase === "active") && s.ranAt && Date.now() - s.ranAt > 1000) {
        this.finish(s.id, "cancelled", "Stopped or replaced manually before the schedule finished.");
      }
    }
  }

  private finish(id: string, status: Schedule["status"], detail: string) {
    this.clearStopTimer(id);
    const s = this.deps.store.get().find((x) => x.id === id);
    if (!s || (s.status !== "running" && s.status !== "scheduled")) return;
    this.patch(id, { status, finishedAt: Date.now(), outcomeDetail: detail });
    log.info(`Schedule “${s.targetLabel}”: ${status} — ${detail}`);
    this.deps.notify(
      status === "completed" ? "Scheduled simulation completed" : `Scheduled simulation ${status}`,
      `${s.targetLabel}: ${detail}`,
    );
  }

  private clearStopTimer(id: string) {
    const t = this.stopTimers.get(id);
    if (t) clearTimeout(t);
    this.stopTimers.delete(id);
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const t of this.stopTimers.values()) clearTimeout(t);
  }
}
