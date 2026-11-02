import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/shared/defaults";
import type { DeviceInfo, HistoryEntry, Settings, SimulationState } from "../../src/shared/types";
import { TestAdapter, testBehaviour, testLog } from "../../src/main/devices/testAdapter";
import { SimulationController, type HistoryRecorder } from "../../src/main/simulation/controller";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const settings: Settings = structuredClone(DEFAULT_SETTINGS);
  settings.location.updateIntervalMs = 40;
  const adapter = new TestAdapter();
  let devices: DeviceInfo[] = [];
  const entries = new Map<string, HistoryEntry>();
  let n = 0;
  const history: HistoryRecorder = {
    begin(e) {
      const id = `h${++n}`;
      entries.set(id, { ...e, id, endedAt: null, outcome: "running" });
      return id;
    },
    finish(id, patch) {
      entries.set(id, { ...entries.get(id)!, ...patch });
    },
  };
  const ctl = new SimulationController({
    getDevice: (id) => devices.find((d) => d.id === id),
    getAdapter: () => adapter,
    getSettings: () => settings,
    history,
  });
  const states: SimulationState[] = [];
  ctl.on("state", (s) => states.push(s));
  return {
    ctl,
    states,
    entries,
    async refresh() {
      devices = await adapter.discover();
    },
  };
}

beforeEach(() => {
  testBehaviour.latencyMs = 20;
  testBehaviour.failNext = null;
  testBehaviour.disconnected = false;
  testLog.length = 0;
});
afterEach(() => {
  testBehaviour.disconnected = false;
});

describe("SimulationController (loopback test adapter)", () => {
  it("only reports active after the adapter confirms, then stops cleanly", async () => {
    const t = setup();
    await t.refresh();
    const res = await t.ctl.startLocation({ deviceId: "test:loopback", point: { lat: 1, lng: 2 }, name: "Spot" });
    expect(res.ok).toBe(true);
    const phases = t.states.map((s) => s.phase);
    expect(phases[0]).toBe("starting");
    expect(phases.at(-1)).toBe("active");
    expect(t.states[0].appliedPosition).toBeNull();
    expect(t.ctl.getState()).toMatchObject({ appliedPosition: { lat: 1, lng: 2 }, confirmation: "test", isTest: true });
    expect([...t.entries.values()][0]).toMatchObject({ outcome: "running", label: "Spot" });

    expect((await t.ctl.stop()).ok).toBe(true);
    expect(t.ctl.getState().phase).toBe("idle");
    expect(testLog.map((l) => l.op)).toEqual(["apply", "clear"]);
    expect([...t.entries.values()][0].outcome).toBe("stopped");
  });

  it("refuses unknown or not-ready devices without changing state", async () => {
    const t = setup();
    const res = await t.ctl.startLocation({ deviceId: "test:loopback", point: { lat: 0, lng: 0 } });
    expect(res.ok).toBe(false);
    expect(t.states).toHaveLength(0);
  });

  it("marks failure (never success) when the device rejects the location", async () => {
    const t = setup();
    await t.refresh();
    testBehaviour.failNext = { code: "rejected", message: "Nope" };
    const res = await t.ctl.startLocation({ deviceId: "test:loopback", point: { lat: 0, lng: 0 } });
    expect(res).toMatchObject({ ok: false, error: "Nope" });
    expect(t.ctl.getState()).toMatchObject({ phase: "failed", appliedPosition: null });
    expect(t.states.some((s) => s.phase === "active")).toBe(false);
    expect(t.entries.size).toBe(0);
  });

  it("fails safely when the device disconnects mid-simulation", async () => {
    const t = setup();
    await t.refresh();
    await t.ctl.startLocation({ deviceId: "test:loopback", point: { lat: 0, lng: 0 } });
    t.ctl.deviceLost("test:loopback");
    await sleep(20);
    await t.ctl.stop().catch(() => undefined); // stop after failure must not throw
    const failed = t.states.find((s) => s.phase === "failed");
    expect(failed?.error?.code).toBe("device-disconnected");
    expect([...t.entries.values()][0].outcome).toBe("failed");
  });

  it("moves along a route, pauses, resumes, arrives and records completion", async () => {
    const t = setup();
    await t.refresh();
    const geometry = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.0006 },
    ]; // ~67 m
    const res = await t.ctl.startRoute({
      deviceId: "test:loopback",
      stops: [],
      geometry,
      mode: "custom",
      speedKmh: 120, // 33 m/s → ~2 s
      loop: false,
    });
    expect(res.ok).toBe(true);
    await sleep(500);
    expect((await t.ctl.pause()).ok).toBe(true);
    const pausedAt = t.ctl.getState().route!.traveledMeters;
    expect(pausedAt).toBeGreaterThan(5);
    await sleep(300);
    expect(t.ctl.getState().route!.traveledMeters).toBe(pausedAt);
    expect(t.ctl.getState().phase).toBe("paused");
    expect((await t.ctl.resume()).ok).toBe(true);
    await sleep(2500);
    const s = t.ctl.getState();
    expect(s.route!.progress).toBe(1);
    expect(s.appliedPosition!.lng).toBeCloseTo(0.0006, 6);
    expect([...t.entries.values()][0].outcome).toBe("completed");
    const applies = testLog.filter((l) => l.op === "apply");
    expect(applies.length).toBeGreaterThan(5);
    // positions only ever move forward along the line
    for (let i = 1; i < applies.length; i++) expect(applies[i].point!.lng).toBeGreaterThanOrEqual(applies[i - 1].point!.lng);
    await t.ctl.stop();
    expect(testLog.at(-1)!.op).toBe("clear");
  });

  it("changes speed mid-route without jumping position", async () => {
    const t = setup();
    await t.refresh();
    await t.ctl.startRoute({
      deviceId: "test:loopback",
      stops: [],
      geometry: [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 0.01 },
      ],
      mode: "walk",
      speedKmh: 5,
      loop: false,
    });
    await sleep(200);
    const before = t.ctl.getState().route!.traveledMeters;
    await t.ctl.setSpeed(50, "drive");
    const after = t.ctl.getState().route!;
    expect(after.traveledMeters).toBeGreaterThanOrEqual(before);
    expect(after.traveledMeters - before).toBeLessThan(1);
    expect(after.speedMps).toBeCloseTo(50 / 3.6, 5);
    await t.ctl.stop();
  });

  it("reminds about the iOS time zone after stopping on an iPhone or iPad", async () => {
    const t = setup();
    await t.refresh();
    const ctl = t.ctl as unknown as { deps: { getDevice: (id: string) => DeviceInfo | undefined } };
    const real = ctl.deps.getDevice;
    ctl.deps.getDevice = (id) => {
      const d = real(id);
      return d && { ...d, adapterId: "ios-device", name: "Test iPad" };
    };
    await t.ctl.startLocation({ deviceId: "test:loopback", point: { lat: 35.66, lng: 139.7 } });
    await t.ctl.stop();
    expect(t.ctl.getState().note).toMatch(/Set Automatically/);
  });

  it("shutdown restores the device and leaves no running engine", async () => {
    const t = setup();
    await t.refresh();
    await t.ctl.startLocation({ deviceId: "test:loopback", point: { lat: 5, lng: 5 } });
    await t.ctl.shutdown(2000);
    expect(t.ctl.getState().phase).toBe("idle");
    expect(testLog.at(-1)!.op).toBe("clear");
  });
});
