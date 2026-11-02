import { randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { clampSpeed, isValidLatLng } from "../shared/geo";
import type {
  Favorite,
  HistoryEntry,
  LatLng,
  Library,
  MovementMode,
  RouteStop,
  SavedRoute,
  Schedule,
  Settings,
} from "../shared/types";

/**
 * Runtime validation for everything crossing a trust boundary: files on disk,
 * imported data and IPC payloads from the renderer.
 */

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const str = (v: unknown, max = 200, fallback = ""): string =>
  typeof v === "string" ? v.slice(0, max) : fallback;
export const optStr = (v: unknown, max = 200): string | undefined =>
  typeof v === "string" && v.trim() ? v.slice(0, max) : undefined;
export const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
export const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  options.includes(v as T) ? (v as T) : fallback;

export function latLng(v: unknown): LatLng | null {
  if (!isObj(v)) return null;
  const p = { lat: Number(v.lat), lng: Number(v.lng) };
  return isValidLatLng(p) ? p : null;
}

export function latLngList(v: unknown, max = 50_000): LatLng[] {
  if (!Array.isArray(v)) return [];
  const out: LatLng[] = [];
  for (const item of v.slice(0, max)) {
    const p = latLng(item);
    if (p) out.push(p);
  }
  return out;
}

export const MODES = ["walk", "cycle", "drive", "custom"] as const;
export const mode = (v: unknown, fallback: MovementMode = "walk") => oneOf(v, MODES, fallback);

export function stops(v: unknown): RouteStop[] {
  if (!Array.isArray(v)) return [];
  const out: RouteStop[] = [];
  for (const s of v.slice(0, 25)) {
    if (!isObj(s)) continue;
    const p = latLng(s.point);
    if (p) out.push({ id: str(s.id, 64) || randomUUID(), point: p, name: optStr(s.name) });
  }
  return out;
}

export function settings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const r = isObj(raw) ? raw : {};
  const g = isObj(r.general) ? r.general : {};
  const dv = isObj(r.devices) ? r.devices : {};
  const l = isObj(r.location) ? r.location : {};
  const o = isObj(r.onboarding) ? r.onboarding : {};
  return {
    general: {
      launchAtStartup: bool(g.launchAtStartup, d.general.launchAtStartup),
      theme: oneOf(g.theme, ["dark", "light", "system"] as const, d.general.theme),
      placeLanguage: str(g.placeLanguage, 8, d.general.placeLanguage) || "local",
      notifications: bool(g.notifications, d.general.notifications),
      defaultMapStyle: oneOf(
        g.defaultMapStyle,
        ["auto", "dark", "light", "streets", "bright"] as const,
        d.general.defaultMapStyle,
      ),
      showIntro: bool(g.showIntro, d.general.showIntro),
    },
    devices: {
      autoRefresh: bool(dv.autoRefresh, d.devices.autoRefresh),
      refreshIntervalSec: Math.min(60, Math.max(2, Math.round(num(dv.refreshIntervalSec, d.devices.refreshIntervalSec)))),
      pymobiledevice3Path: str(dv.pymobiledevice3Path, 1024),
      adbPath: str(dv.adbPath, 1024),
      iosTunnel: oneOf(dv.iosTunnel, ["auto", "userspace", "tunneld"] as const, d.devices.iosTunnel),
      showTestAdapter: bool(dv.showTestAdapter, d.devices.showTestAdapter),
    },
    location: {
      defaultMode: mode(l.defaultMode, d.location.defaultMode),
      customSpeedKmh: clampSpeed(num(l.customSpeedKmh, d.location.customSpeedKmh)),
      units: oneOf(l.units, ["metric", "imperial"] as const, d.location.units),
      coordFormat: oneOf(l.coordFormat, ["decimal", "dms"] as const, d.location.coordFormat),
      keepAwake: bool(l.keepAwake, d.location.keepAwake),
      confirmBeforeStart: bool(l.confirmBeforeStart, d.location.confirmBeforeStart),
      updateIntervalMs: [500, 1000, 2000].includes(num(l.updateIntervalMs, 0)) ? num(l.updateIntervalMs, 1000) : 1000,
      defaultPathMode: oneOf(l.defaultPathMode, ["roads", "direct"] as const, d.location.defaultPathMode),
    },
    onboarding: {
      completedAt: typeof o.completedAt === "number" ? o.completedAt : null,
      version: num(o.version, d.onboarding.version),
    },
  };
}

export function favorite(v: unknown): Favorite | null {
  if (!isObj(v)) return null;
  const p = latLng(v.point);
  const name = str(v.name, 120).trim();
  if (!p || !name) return null;
  const now = Date.now();
  return {
    id: str(v.id, 64) || randomUUID(),
    name,
    point: p,
    address: optStr(v.address, 300),
    group: optStr(v.group, 60),
    note: optStr(v.note, 500),
    createdAt: num(v.createdAt, now),
    updatedAt: num(v.updatedAt, now),
    lastUsedAt: typeof v.lastUsedAt === "number" ? v.lastUsedAt : undefined,
  };
}

export function savedRoute(v: unknown): SavedRoute | null {
  if (!isObj(v)) return null;
  const s = stops(v.stops);
  const name = str(v.name, 120).trim();
  if (s.length < 2 || !name) return null;
  const now = Date.now();
  const geometry = latLngList(v.geometry);
  return {
    id: str(v.id, 64) || randomUUID(),
    name,
    stops: s,
    mode: mode(v.mode),
    customSpeedKmh: typeof v.customSpeedKmh === "number" ? clampSpeed(v.customSpeedKmh) : undefined,
    pathMode: oneOf(v.pathMode, ["roads", "direct"] as const, "roads"),
    loop: bool(v.loop, false),
    geometry: geometry.length >= 2 ? geometry : undefined,
    distanceMeters: typeof v.distanceMeters === "number" ? v.distanceMeters : undefined,
    createdAt: num(v.createdAt, now),
    updatedAt: num(v.updatedAt, now),
  };
}

export function library(raw: unknown): Library {
  const r = isObj(raw) ? raw : {};
  const favorites = (Array.isArray(r.favorites) ? r.favorites : []).map(favorite).filter(Boolean) as Favorite[];
  const routes = (Array.isArray(r.routes) ? r.routes : []).map(savedRoute).filter(Boolean) as SavedRoute[];
  return { favorites: favorites.slice(0, 5000), routes: routes.slice(0, 1000) };
}

export function history(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isObj)
    .map((h) => {
      const p = latLng(h.point);
      if (!p) return null;
      const outcome = oneOf(h.outcome, ["running", "stopped", "completed", "failed"] as const, "stopped");
      return {
        id: str(h.id, 64) || randomUUID(),
        kind: oneOf(h.kind, ["location", "route"] as const, "location"),
        label: str(h.label, 200),
        point: p,
        deviceName: str(h.deviceName, 120),
        adapterId: oneOf(h.adapterId, ["ios-simulator", "ios-device", "android-emulator", "test"] as const, "test"),
        isTest: bool(h.isTest, false),
        startedAt: num(h.startedAt, 0),
        endedAt: typeof h.endedAt === "number" ? h.endedAt : null,
        // A run that was still "running" when the app last closed did not end cleanly.
        outcome: outcome === "running" ? "stopped" : outcome,
        error: optStr(h.error, 500),
        distanceMeters: typeof h.distanceMeters === "number" ? h.distanceMeters : undefined,
        scheduleId: optStr(h.scheduleId, 64),
      } satisfies HistoryEntry;
    })
    .filter(Boolean)
    .slice(0, 500) as HistoryEntry[];
}

export function schedules(raw: unknown): Schedule[] {
  if (!Array.isArray(raw)) return [];
  const out: Schedule[] = [];
  for (const s of raw.filter(isObj)) {
    const t = isObj(s.target) ? s.target : null;
    let target: Schedule["target"] | null = null;
    if (t?.kind === "favorite" && typeof t.favoriteId === "string") target = { kind: "favorite", favoriteId: t.favoriteId };
    if (t?.kind === "route" && typeof t.routeId === "string") target = { kind: "route", routeId: t.routeId };
    if (!target || typeof s.startAt !== "number") continue;
    out.push({
      id: str(s.id, 64) || randomUUID(),
      target,
      targetLabel: str(s.targetLabel, 200),
      deviceId: str(s.deviceId, 200),
      deviceName: str(s.deviceName, 120),
      startAt: s.startAt,
      durationMinutes: typeof s.durationMinutes === "number" ? s.durationMinutes : null,
      consentAt: num(s.consentAt, 0),
      status: oneOf(
        s.status,
        ["scheduled", "running", "completed", "failed", "missed", "cancelled"] as const,
        "scheduled",
      ),
      createdAt: num(s.createdAt, 0),
      ranAt: typeof s.ranAt === "number" ? s.ranAt : undefined,
      finishedAt: typeof s.finishedAt === "number" ? s.finishedAt : undefined,
      outcomeDetail: optStr(s.outcomeDetail, 500),
    });
  }
  return out.slice(0, 500);
}
