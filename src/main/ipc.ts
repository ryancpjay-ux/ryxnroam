import { BrowserWindow, app, clipboard, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { clampSpeed } from "../shared/geo";
import { buildRouteGpx } from "../shared/gpx";
import { CH, EV, type DeepPartial, type NewSchedule, type Result } from "../shared/ipc";
import type { AppInfo, DeviceAction, Favorite, Library, SavedRoute, Settings } from "../shared/types";
import type { DeviceManager } from "./devices/manager";
import type { History } from "./history";
import { getLogs } from "./log";
import * as v from "./sanitize";
import type { Scheduler } from "./scheduler";
import * as geocoding from "./services/geocoding";
import { computeRoute } from "./services/routing";
import type { SimulationController } from "./simulation/controller";
import type { JsonStore } from "./store";
import type { Updates } from "./updates";

declare const __BUILD_DATE__: string;
declare const __COMMIT__: string;

interface Deps {
  getWindow(): BrowserWindow | null;
  settingsStore: JsonStore<Settings>;
  libraryStore: JsonStore<Library>;
  history: History;
  devices: DeviceManager;
  controller: SimulationController;
  scheduler: Scheduler;
  updates: Updates;
  onSettingsChanged(prev: Settings, next: Settings): void;
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = (e: unknown, code?: string): Result<never> => ({
  ok: false,
  error: e instanceof Error ? e.message : String(e),
  code,
});

function deepMerge<T>(base: T, patch: unknown): T {
  if (!v.isObj(patch) || !v.isObj(base)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, val] of Object.entries(patch)) {
    // Own, known keys only — never inherited ones such as __proto__.
    if (!Object.hasOwn(out, k) || k === "__proto__" || k === "constructor") continue;
    out[k] = v.isObj(val) && v.isObj(out[k]) ? deepMerge(out[k], val) : val;
  }
  return out as T;
}

export function registerIpc(d: Deps) {
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (_e, ...args) => fn(...args));
  const emitLibrary = () => d.getWindow()?.webContents.send(EV.library, d.libraryStore.get());

  // ------------------------------------------------------------------ app
  handle(CH.appInfo, (): AppInfo => ({
    name: "ryxnroam",
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    buildDate: typeof __BUILD_DATE__ === "string" ? __BUILD_DATE__ : "dev",
    commit: typeof __COMMIT__ === "string" ? __COMMIT__ : "dev",
    packaged: app.isPackaged,
    userDataPath: app.getPath("userData"),
  }));
  ipcMain.on(CH.appWindow, (_e, action: unknown) => {
    const w = d.getWindow();
    if (!w) return;
    if (action === "minimize") w.minimize();
    else if (action === "maximize") (w.isMaximized() ? w.unmaximize() : w.maximize());
    else if (action === "close") w.close();
  });
  handle(CH.appOpenExternal, async (url: unknown) => {
    if (typeof url === "string" && /^https:\/\/[^\s]+$/.test(url)) await shell.openExternal(url);
  });

  // ------------------------------------------------------------- settings
  handle(CH.settingsGet, () => d.settingsStore.get());
  handle(CH.settingsUpdate, (patch: DeepPartial<Settings>) => {
    const prev = d.settingsStore.get();
    const next = v.settings(deepMerge(prev, patch));
    d.settingsStore.set(next);
    d.onSettingsChanged(prev, next);
    return next;
  });

  // -------------------------------------------------------------- devices
  handle(CH.devicesSnapshot, () => d.devices.snapshot());
  handle(CH.devicesRefresh, () => d.devices.refresh());
  handle(CH.devicesAction, async (deviceId: unknown, action: unknown) => {
    const actions = ["mount-ddi", "recheck", "enable-wifi", "disable-wifi"];
    if (typeof deviceId !== "string" || typeof action !== "string" || !actions.includes(action)) return err("Invalid request");
    try {
      return ok(await d.devices.runAction(deviceId, action as DeviceAction["id"]));
    } catch (e) {
      return err(e);
    }
  });

  // ----------------------------------------------------------- simulation
  const wrap = async (p: Promise<{ ok: true } | { ok: false; error: string; code?: string }>): Promise<Result> => {
    const r = await p;
    return r.ok ? ok(undefined) : err(r.error, r.code);
  };
  handle(CH.simState, () => d.controller.getState());
  handle(CH.simStartLocation, (req: unknown) => {
    const r = v.isObj(req) ? req : {};
    const point = v.latLng(r.point);
    if (!point || typeof r.deviceId !== "string") return err("Choose a device and a valid location.");
    return wrap(d.controller.startLocation({ deviceId: r.deviceId, point, name: v.optStr(r.name, 200) }));
  });
  handle(CH.simStartRoute, (req: unknown) => {
    const r = v.isObj(req) ? req : {};
    const geometry = v.latLngList(r.geometry);
    if (typeof r.deviceId !== "string" || geometry.length < 2) return err("Choose a device and a route with two or more stops.");
    return wrap(
      d.controller.startRoute({
        deviceId: r.deviceId,
        name: v.optStr(r.name, 200),
        stops: v.stops(r.stops),
        geometry,
        mode: v.mode(r.mode),
        speedKmh: clampSpeed(v.num(r.speedKmh, 5)),
        loop: v.bool(r.loop, false),
      }),
    );
  });
  handle(CH.simPause, () => wrap(d.controller.pause()));
  handle(CH.simResume, () => wrap(d.controller.resume()));
  handle(CH.simSetSpeed, (kmh: unknown, mode: unknown) => wrap(d.controller.setSpeed(clampSpeed(v.num(kmh, 5)), v.mode(mode))));
  handle(CH.simStop, () => wrap(d.controller.stop()));
  handle(CH.simDismiss, () => d.controller.dismissError());

  // ------------------------------------------------------------------ geo
  let searchAbort: AbortController | null = null;
  handle(CH.geoSearch, async (query: unknown, opts: unknown) => {
    const o = v.isObj(opts) ? opts : {};
    searchAbort?.abort();
    const ctl = (searchAbort = new AbortController());
    try {
      const results = await geocoding.search(v.str(query, 200), {
        bias: v.latLng(o.bias) ?? undefined,
        submit: v.bool(o.submit, false),
        lang: d.settingsStore.get().general.placeLanguage,
        signal: ctl.signal,
      });
      return ok(results);
    } catch (e) {
      return ctl.signal.aborted ? err("cancelled", "cancelled") : err(e);
    }
  });
  handle(CH.geoReverse, async (point: unknown) => {
    const p = v.latLng(point);
    if (!p) return err("Invalid coordinates");
    try {
      return ok(await geocoding.reverse(p, d.settingsStore.get().general.placeLanguage));
    } catch (e) {
      return err(e);
    }
  });
  let routeAbort: AbortController | null = null;
  handle(CH.geoRoute, async (stops: unknown, mode: unknown, pathMode: unknown) => {
    const pts = v.latLngList(stops, 25);
    if (pts.length < 2) return err("Add at least a start and a destination.");
    routeAbort?.abort();
    const ctl = (routeAbort = new AbortController());
    try {
      return ok(await computeRoute(pts, v.mode(mode), pathMode === "direct" ? "direct" : "roads", ctl.signal));
    } catch (e) {
      return ctl.signal.aborted ? err("cancelled", "cancelled") : err(e);
    }
  });

  // -------------------------------------------------------------- library
  handle(CH.libGet, () => d.libraryStore.get());
  handle(CH.libSaveFavorite, (input: unknown) => {
    const now = Date.now();
    const existing = v.isObj(input) && typeof input.id === "string"
      ? d.libraryStore.get().favorites.find((f) => f.id === input.id)
      : undefined;
    const fav = v.favorite({ ...(existing ?? {}), ...(v.isObj(input) ? input : {}), id: existing?.id ?? randomUUID(), createdAt: existing?.createdAt ?? now, updatedAt: now });
    if (!fav) throw new Error("A saved location needs a name and valid coordinates.");
    d.libraryStore.update((l) => ({
      ...l,
      favorites: existing ? l.favorites.map((f) => (f.id === fav.id ? fav : f)) : [fav, ...l.favorites],
    }));
    emitLibrary();
    return fav satisfies Favorite;
  });
  handle(CH.libDeleteFavorite, (id: unknown) => {
    d.libraryStore.update((l) => ({ ...l, favorites: l.favorites.filter((f) => f.id !== id) }));
    emitLibrary();
  });
  handle(CH.libTouchFavorite, (id: unknown) => {
    d.libraryStore.update((l) => ({
      ...l,
      favorites: l.favorites.map((f) => (f.id === id ? { ...f, lastUsedAt: Date.now() } : f)),
    }));
    emitLibrary();
  });
  handle(CH.libSaveRoute, (input: unknown) => {
    const now = Date.now();
    const existing = v.isObj(input) && typeof input.id === "string"
      ? d.libraryStore.get().routes.find((r) => r.id === input.id)
      : undefined;
    const route = v.savedRoute({ ...(existing ?? {}), ...(v.isObj(input) ? input : {}), id: existing?.id ?? randomUUID(), createdAt: existing?.createdAt ?? now, updatedAt: now });
    if (!route) throw new Error("A saved route needs a name and at least two stops.");
    d.libraryStore.update((l) => ({
      ...l,
      routes: existing ? l.routes.map((r) => (r.id === route.id ? route : r)) : [route, ...l.routes],
    }));
    emitLibrary();
    return route satisfies SavedRoute;
  });
  handle(CH.libDeleteRoute, (id: unknown) => {
    d.libraryStore.update((l) => ({ ...l, routes: l.routes.filter((r) => r.id !== id) }));
    emitLibrary();
  });
  handle(CH.libExportRouteGpx, async (id: unknown) => {
    const route = d.libraryStore.get().routes.find((r) => r.id === id);
    if (!route) return err("Route not found");
    const geometry = route.geometry ?? route.stops.map((s) => s.point);
    const w = d.getWindow();
    const opts = { defaultPath: `${route.name.replace(/[^\w\- ]+/g, "").trim() || "route"}.gpx`, filters: [{ name: "GPX", extensions: ["gpx"] }] };
    const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return err("cancelled", "cancelled");
    await fs.writeFile(res.filePath, buildRouteGpx(route.name, geometry), "utf8");
    return ok(res.filePath);
  });

  // -------------------------------------------------------------- history
  handle(CH.historyList, () => d.history.list());
  handle(CH.historyClear, () => d.history.clear());

  // ------------------------------------------------------------ schedules
  handle(CH.schedList, () => d.scheduler.list());
  handle(CH.schedCreate, (input: unknown) => {
    const i = v.isObj(input) ? input : {};
    const t = v.isObj(i.target) ? i.target : {};
    const target =
      t.kind === "favorite" && typeof t.favoriteId === "string"
        ? ({ kind: "favorite", favoriteId: t.favoriteId } as const)
        : t.kind === "route" && typeof t.routeId === "string"
          ? ({ kind: "route", routeId: t.routeId } as const)
          : null;
    if (!target || typeof i.deviceId !== "string") return err("Choose a saved location or route and a device.");
    try {
      const s: NewSchedule = {
        target,
        deviceId: i.deviceId,
        startAt: v.num(i.startAt, 0),
        durationMinutes: typeof i.durationMinutes === "number" ? Math.round(i.durationMinutes) : null,
        consent: i.consent === true ? true : (undefined as unknown as true),
      };
      return ok(d.scheduler.create(s));
    } catch (e) {
      return err(e);
    }
  });
  handle(CH.schedCancel, (id: unknown) => typeof id === "string" && d.scheduler.cancel(id));
  handle(CH.schedRemove, (id: unknown) => typeof id === "string" && d.scheduler.remove(id));

  // ----------------------------------------------------------------- data
  handle(CH.dataExport, async () => {
    const w = d.getWindow();
    const opts = {
      defaultPath: `ryxnroam-export-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const res = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return err("cancelled", "cancelled");
    const lib = d.libraryStore.get();
    const body = { app: "ryxnroam", format: 1, exportedAt: new Date().toISOString(), favorites: lib.favorites, routes: lib.routes };
    await fs.writeFile(res.filePath, JSON.stringify(body, null, 2), "utf8");
    return ok(res.filePath);
  });
  handle(CH.dataImport, async () => {
    const w = d.getWindow();
    const opts = { properties: ["openFile" as const], filters: [{ name: "JSON", extensions: ["json"] }] };
    const res = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return err("cancelled", "cancelled");
    try {
      const stat = await fs.stat(res.filePaths[0]);
      if (stat.size > 20 * 1024 * 1024) return err("That file is too large to be a ryxnroam export.");
      const raw = JSON.parse(await fs.readFile(res.filePaths[0], "utf8"));
      if (!v.isObj(raw) || raw.app !== "ryxnroam") return err("That file is not a ryxnroam export.");
      const incoming = v.library(raw);
      d.libraryStore.update((l) => {
        const favIds = new Set(l.favorites.map((f) => f.id));
        const routeIds = new Set(l.routes.map((r) => r.id));
        return {
          favorites: [...incoming.favorites.filter((f) => !favIds.has(f.id)), ...l.favorites],
          routes: [...incoming.routes.filter((r) => !routeIds.has(r.id)), ...l.routes],
        };
      });
      emitLibrary();
      return ok({ favorites: incoming.favorites.length, routes: incoming.routes.length });
    } catch (e) {
      return err(`Could not import: ${(e as Error).message}`);
    }
  });

  // -------------------------------------------------------------- updates
  handle(CH.updStatus, () => d.updates.get());
  handle(CH.updCheck, () => d.updates.check());
  handle(CH.updDownload, () => d.updates.download());
  handle(CH.updInstall, () => d.updates.install());

  // ---------------------------------------------------------- diagnostics
  handle(CH.diagLogs, () => getLogs());
  handle(CH.diagReport, () => {
    const snap = d.devices.snapshot();
    const sim = d.controller.getState();
    const lines = [
      `ryxnroam ${app.getVersion()} — ${process.platform} ${process.arch} — Electron ${process.versions.electron}`,
      `Generated ${new Date().toISOString()}`,
      "",
      "Integrations:",
      ...snap.adapters.map(
        (a) =>
          `  • ${a.label}: ${a.available ? "available" : a.platformSupported ? "not available" : "not supported on this OS"}${a.toolVersion ? ` (${a.toolVersion})` : ""} — ${a.detail}`,
      ),
      "",
      "Devices:",
      ...(snap.devices.length
        ? snap.devices.map((x) => `  • ${x.name} [${x.adapterId}] ${x.osName ?? ""} ${x.osVersion ?? ""} — ${x.state}${x.stateDetail ? `: ${x.stateDetail}` : ""}`)
        : ["  (none)"]),
      "",
      `Simulation: ${sim.phase}${sim.deviceName ? ` on ${sim.deviceName}` : ""}${sim.error ? ` — ${sim.error.message}` : ""}`,
      "",
      "Recent log:",
      ...getLogs()
        .slice(-80)
        .map((l) => `  ${new Date(l.t).toISOString().slice(11, 19)} ${l.level.toUpperCase().padEnd(5)} [${l.scope}] ${l.msg}`),
    ];
    // Coordinates are redacted so a shared report never reveals a location.
    return lines.join("\n").replace(/-?\d{1,3}\.\d{4,}/g, "‹coord›");
  });
  handle(CH.diagCopy, (text: unknown) => clipboard.writeText(v.str(text, 200_000)));
}
