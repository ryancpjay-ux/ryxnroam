import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/shared/defaults";
import type { Favorite, Library, Schedule, Settings } from "../../src/shared/types";
import { TestAdapter, testBehaviour } from "../../src/main/devices/testAdapter";
import * as sanitize from "../../src/main/sanitize";
import { Scheduler } from "../../src/main/scheduler";
import { configureHttp } from "../../src/main/services/http";
import { computeRoute } from "../../src/main/services/routing";
import { search } from "../../src/main/services/geocoding";
import { SimulationController } from "../../src/main/simulation/controller";
import { JsonStore } from "../../src/main/store";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "ryxnroam-test-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("JsonStore", () => {
  it("persists atomically and reloads", async () => {
    const dir = tmp();
    const a = new JsonStore<{ n: number }>(dir, "doc", 1, () => ({ n: 0 }), (r) => r as { n: number });
    a.set({ n: 42 });
    await a.flush();
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const b = new JsonStore<{ n: number }>(dir, "doc", 1, () => ({ n: 0 }), (r) => r as { n: number });
    expect(b.get().n).toBe(42);
  });

  it("keeps a corrupt file aside instead of overwriting it", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "doc.json"), "{not json");
    const s = new JsonStore<{ n: number }>(dir, "doc", 1, () => ({ n: 7 }), (r) => r as { n: number });
    expect(s.get().n).toBe(7);
    expect(readdirSync(dir).some((f) => f.startsWith("doc.corrupt-"))).toBe(true);
  });
});

describe("sanitize", () => {
  it("rebuilds settings from garbage with defaults", () => {
    const s = sanitize.settings({ general: { theme: "neon", notifications: "yes" }, location: { customSpeedKmh: 9999, updateIntervalMs: 7 } });
    expect(s.general.theme).toBe("dark");
    expect(s.general.notifications).toBe(true);
    expect(s.location.customSpeedKmh).toBe(300);
    expect(s.location.updateIntervalMs).toBe(1000);
  });

  it("falls back to Auto for a map style that no longer exists", () => {
    expect(sanitize.settings({ general: { defaultMapStyle: "satellite" } }).general.defaultMapStyle).toBe("auto");
  });

  it("drops invalid library items", () => {
    const lib = sanitize.library({
      favorites: [{ name: "ok", point: { lat: 1, lng: 1 } }, { name: "", point: { lat: 1, lng: 1 } }, { name: "bad", point: { lat: 99, lng: 0 } }],
      routes: [{ name: "r", stops: [{ point: { lat: 0, lng: 0 } }] }],
    });
    expect(lib.favorites.map((f) => f.name)).toEqual(["ok"]);
    expect(lib.routes).toEqual([]);
  });

  it("does not resurrect a 'running' history entry after restart", () => {
    const [h] = sanitize.history([{ point: { lat: 0, lng: 0 }, outcome: "running", startedAt: 1 }]);
    expect(h.outcome).toBe("stopped");
  });
});

describe("Scheduler", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp();
    testBehaviour.latencyMs = 10;
    testBehaviour.disconnected = false;
    testBehaviour.failNext = null;
  });

  async function make(devicesPresent = true) {
    const settings: Settings = structuredClone(DEFAULT_SETTINGS);
    settings.location.updateIntervalMs = 50;
    const adapter = new TestAdapter();
    const devices = devicesPresent ? await adapter.discover() : [];
    const fav: Favorite = { id: "f1", name: "Office", point: { lat: 3, lng: 4 }, createdAt: 0, updatedAt: 0 };
    const library: Library = { favorites: [fav], routes: [] };
    const controller = new SimulationController({
      getDevice: (id) => devices.find((d) => d.id === id),
      getAdapter: () => adapter,
      getSettings: () => settings,
      history: { begin: () => "h", finish: () => {} },
    });
    const store = new JsonStore<Schedule[]>(dir, "schedules", 1, () => [], (r) => sanitize.schedules(r));
    const notes: string[] = [];
    const scheduler = new Scheduler({
      store,
      controller,
      getLibrary: () => library,
      getDevice: (id) => devices.find((d) => d.id === id),
      getSettings: () => settings,
      notify: (t, b) => notes.push(`${t}: ${b}`),
    });
    return { scheduler, controller, store, notes };
  }

  it("requires consent and a future start", async () => {
    const { scheduler } = await make();
    expect(() =>
      scheduler.create({ target: { kind: "favorite", favoriteId: "f1" }, deviceId: "test:loopback", startAt: Date.now() + 1000, durationMinutes: null, consent: false as true }),
    ).toThrow(/authorized/);
    expect(() =>
      scheduler.create({ target: { kind: "favorite", favoriteId: "f1" }, deviceId: "test:loopback", startAt: Date.now() - 600_000, durationMinutes: null, consent: true }),
    ).toThrow(/future/);
  });

  it("runs a due schedule and records completion only after the device accepted it", async () => {
    const { scheduler, controller, notes } = await make();
    scheduler.start();
    const s = scheduler.create({ target: { kind: "favorite", favoriteId: "f1" }, deviceId: "test:loopback", startAt: Date.now() + 300, durationMinutes: null, consent: true });
    await sleep(900);
    const done = scheduler.list().find((x) => x.id === s.id)!;
    expect(done.status).toBe("completed");
    expect(controller.getState()).toMatchObject({ phase: "active", scheduleId: s.id, appliedPosition: { lat: 3, lng: 4 } });
    expect(notes.join("\n")).toMatch(/started/);
    await controller.stop();
    scheduler.dispose();
  });

  it("fails (not completes) when the device is missing at start time", async () => {
    const { scheduler } = await make(false);
    scheduler.start();
    const s = scheduler.create({ target: { kind: "favorite", favoriteId: "f1" }, deviceId: "test:loopback", startAt: Date.now() + 200, durationMinutes: null, consent: true });
    await sleep(700);
    const r = scheduler.list().find((x) => x.id === s.id)!;
    expect(r.status).toBe("failed");
    expect(r.outcomeDetail).toMatch(/not connected/);
    scheduler.dispose();
  });

  it("marks schedules missed while the app was closed", async () => {
    const store = new JsonStore<Schedule[]>(dir, "schedules", 1, () => [], (r) => sanitize.schedules(r));
    store.set([
      {
        id: "old",
        target: { kind: "favorite", favoriteId: "f1" },
        targetLabel: "Office",
        deviceId: "test:loopback",
        deviceName: "Loopback",
        startAt: Date.now() - 3_600_000,
        durationMinutes: null,
        consentAt: 1,
        status: "scheduled",
        createdAt: 1,
      },
    ]);
    await store.flush();
    const { scheduler } = await make();
    scheduler.start();
    expect(scheduler.list()[0].status).toBe("missed");
    scheduler.dispose();
  });

  it("cancels a scheduled run", async () => {
    const { scheduler } = await make();
    scheduler.start();
    const s = scheduler.create({ target: { kind: "favorite", favoriteId: "f1" }, deviceId: "test:loopback", startAt: Date.now() + 60_000, durationMinutes: 5, consent: true });
    scheduler.cancel(s.id);
    expect(scheduler.list()[0].status).toBe("cancelled");
    scheduler.dispose();
  });
});

describe("network services (stubbed HTTP)", () => {
  it("falls back to straight lines and says why when routing fails", async () => {
    configureHttp(async () => new Response("down", { status: 503 }), "test");
    const r = await computeRoute([{ lat: 0, lng: 0 }, { lat: 0, lng: 0.01 }], "walk", "roads");
    expect(r.provider).toBe("direct");
    expect(r.fallbackReason).toMatch(/503/);
    expect(r.distanceMeters).toBeCloseTo(1113, -1);
  });

  it("parses OSRM geometry", async () => {
    configureHttp(
      async () =>
        Response.json({ code: "Ok", routes: [{ distance: 1500, duration: 1000, geometry: { coordinates: [[1, 2], [1.01, 2.01]] } }] }),
      "test",
    );
    const r = await computeRoute([{ lat: 2, lng: 1 }, { lat: 2.01, lng: 1.01 }], "cycle", "roads");
    expect(r).toMatchObject({ provider: "osrm", distanceMeters: 1500, geometry: [{ lat: 2, lng: 1 }, { lat: 2.01, lng: 1.01 }] });
  });

  it("maps Photon features into results and sends an identifying User-Agent", async () => {
    let ua = "";
    configureHttp(async (_url, init) => {
      ua = (init?.headers as Record<string, string>)["User-Agent"];
      return Response.json({
        features: [{ geometry: { coordinates: [2.2945, 48.8584] }, properties: { osm_type: "W", osm_id: 5013364, name: "Tour Eiffel", city: "Paris", country: "France" } }],
      });
    }, "ryxnroam/test");
    const [r] = await search("eiffel tower unique", { lang: "en" });
    expect(r).toMatchObject({ name: "Tour Eiffel", detail: "Paris, France", point: { lat: 48.8584, lng: 2.2945 } });
    expect(ua).toBe("ryxnroam/test");
  });
});
