import { create } from "zustand";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { speedKmh } from "../shared/geo";
import type { DeepPartial } from "../shared/ipc";
import type {
  AppInfo,
  ComputedRoute,
  DevicesSnapshot,
  HistoryEntry,
  LatLng,
  Library,
  MovementMode,
  PathMode,
  RouteStop,
  Schedule,
  Settings,
  SimulationState,
  UpdateStatus,
} from "../shared/types";
import { api } from "./api";

export type Section = "saved" | "routes" | "schedule" | "history";
export type SettingsTab = "general" | "devices" | "location" | "data" | "about";

export interface Selection {
  point: LatLng;
  name?: string;
  detail?: string;
  source: "map" | "search" | "favorite" | "coords" | "history" | "device";
  resolving?: boolean;
  favoriteId?: string;
}

export interface RouteDraft {
  stops: RouteStop[];
  computed: ComputedRoute | null;
  computing: boolean;
  error: string | null;
  mode: MovementMode;
  customKmh: number;
  pathMode: PathMode;
  loop: boolean;
  name: string | null;
  savedId: string | null;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
  leaving?: boolean;
}

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  checkbox?: string;
  resolve: (r: { ok: boolean; checked: boolean }) => void;
}

export type MapCommand =
  | { kind: "fly"; point: LatLng; zoom?: number; id: number }
  | { kind: "fit"; bbox: [number, number, number, number]; id: number }
  | { kind: "fitPoints"; points: LatLng[]; id: number }
  | { kind: "zoom"; delta: number; id: number };

const EMPTY_SIM: SimulationState = {
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

interface State {
  ready: boolean;
  info: AppInfo | null;
  settings: Settings;
  devices: DevicesSnapshot;
  sim: SimulationState;
  library: Library;
  history: HistoryEntry[];
  schedules: Schedule[];
  update: UpdateStatus;
  selectedDeviceId: string | null;
  mode: "location" | "route";
  selection: Selection | null;
  route: RouteDraft;
  sidebarOpen: boolean;
  section: Section;
  mapStyleOverride: Settings["general"]["defaultMapStyle"] | null;
  mapCommand: MapCommand | null;
  mapCenter: LatLng | null;
  settingsOpen: SettingsTab | null;
  onboardingOpen: boolean;
  introVisible: boolean;
  favoriteEditor: { id?: string; name: string; point: LatLng; address?: string; group?: string; note?: string } | null;
  scheduleEditor: { target?: Schedule["target"] } | null;
  routeNamer: boolean;
  confirm: ConfirmRequest | null;
  toasts: Toast[];
  windowMaximized: boolean;
}

export const useStore = create<State>(() => ({
  ready: false,
  info: null,
  settings: DEFAULT_SETTINGS,
  devices: { devices: [], adapters: [], scanning: true, lastScanAt: null },
  sim: EMPTY_SIM,
  library: { favorites: [], routes: [] },
  history: [],
  schedules: [],
  update: { state: "idle" },
  selectedDeviceId: null,
  mode: "location",
  selection: null,
  route: {
    stops: [],
    computed: null,
    computing: false,
    error: null,
    mode: "walk",
    customKmh: 30,
    pathMode: "roads",
    loop: false,
    name: null,
    savedId: null,
  },
  sidebarOpen: true,
  section: "saved",
  mapStyleOverride: null,
  mapCommand: null,
  mapCenter: null,
  settingsOpen: null,
  onboardingOpen: false,
  introVisible: false,
  favoriteEditor: null,
  scheduleEditor: null,
  routeNamer: false,
  confirm: null,
  toasts: [],
  windowMaximized: false,
}));

const set = useStore.setState;
const get = useStore.getState;

// ------------------------------------------------------------------ toasts
let toastId = 0;
export function toast(text: string, kind: Toast["kind"] = "info") {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts.slice(-2), { id, kind, text }] }));
  setTimeout(() => dismissToast(id), kind === "error" ? 7000 : 3800);
}
export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 220);
}

export function confirmAction(req: Omit<ConfirmRequest, "resolve">): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((resolve) => set({ confirm: { ...req, resolve } }));
}

// ------------------------------------------------------------------- init
export async function init() {
  const [info, settings, devices, sim, library, history, schedules, update] = await Promise.all([
    api.app.info(),
    api.settings.get(),
    api.devices.snapshot(),
    api.simulation.state(),
    api.library.get(),
    api.history.list(),
    api.schedules.list(),
    api.updates.status(),
  ]);
  set({
    info,
    settings,
    devices,
    sim,
    library,
    history,
    schedules,
    update,
    ready: true,
    introVisible: settings.general.showIntro || !settings.onboarding.completedAt,
    route: { ...get().route, mode: settings.location.defaultMode, customKmh: settings.location.customSpeedKmh, pathMode: settings.location.defaultPathMode },
  });
  pickDefaultDevice();
  api.settings.onChange((s) => set({ settings: s }));
  api.devices.onChange((d) => {
    set({ devices: d });
    pickDefaultDevice();
  });
  api.simulation.onState((s) => set({ sim: s }));
  api.library.onChange((l) => set({ library: l }));
  api.history.onChange((h) => set({ history: h }));
  api.schedules.onChange((s) => set({ schedules: s }));
  api.updates.onStatus((u) => set({ update: u }));
  api.app.onWindowState((w) => set({ windowMaximized: w.maximized }));
  api.app.onCommand((cmd) => {
    if (cmd === "open-settings") set({ settingsOpen: "general" });
    if (cmd === "stop-simulation") void stopSimulation();
  });
}

const DEVICE_KEY = "ryxnroam.device";

function rememberedDevice(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

/** True while the current selection was made automatically rather than by the user. */
let autoPicked = false;

/** The user's explicit choice; remembered on this computer so a restart keeps it. */
export function chooseDevice(id: string) {
  autoPicked = false;
  set({ selectedDeviceId: id });
  try {
    localStorage.setItem(DEVICE_KEY, id);
  } catch {
    /* storage unavailable: the choice still applies for this session */
  }
}

function pickDefaultDevice() {
  const { devices, selectedDeviceId, sim } = get();
  if (sim.deviceId && devices.devices.some((d) => d.id === sim.deviceId)) {
    if (selectedDeviceId !== sim.deviceId && !selectedDeviceId) set({ selectedDeviceId: sim.deviceId });
    return;
  }
  const remembered = rememberedDevice();
  // The remembered device often shows up after another one (e.g. over Wi-Fi): let it win over an automatic pick.
  if (autoPicked && remembered && remembered !== selectedDeviceId && devices.devices.some((d) => d.id === remembered)) {
    autoPicked = false;
    set({ selectedDeviceId: remembered });
    return;
  }
  if (selectedDeviceId && devices.devices.some((d) => d.id === selectedDeviceId)) return;
  const best =
    devices.devices.find((d) => d.id === remembered) ??
    devices.devices.find((d) => d.state === "connected" && !d.isTest) ??
    devices.devices.find((d) => d.state === "connected") ??
    devices.devices[0];
  // Keep the user's chosen id while it is temporarily missing (e.g. a cable wiggle).
  if (best || !selectedDeviceId) {
    autoPicked = !!best && best.id !== remembered;
    set({ selectedDeviceId: best?.id ?? null });
  }
}

export function selectedDevice() {
  const { devices, selectedDeviceId } = get();
  return devices.devices.find((d) => d.id === selectedDeviceId) ?? null;
}

// --------------------------------------------------------------- settings
export async function updateSettings(patch: DeepPartial<Settings>) {
  const next = await api.settings.update(patch);
  set({ settings: next });
  return next;
}

// -------------------------------------------------------------- selection
let reverseTimer: ReturnType<typeof setTimeout> | null = null;
let reverseSeq = 0;

export function selectPoint(point: LatLng, meta: Partial<Omit<Selection, "point">> = {}, opts: { fly?: boolean; zoom?: number } = {}) {
  const needsName = !meta.name;
  set({ selection: { point, source: meta.source ?? "map", ...meta, resolving: needsName }, mode: get().mode });
  if (opts.fly) flyTo(point, opts.zoom);
  if (reverseTimer) clearTimeout(reverseTimer);
  if (!needsName) return;
  const seq = ++reverseSeq;
  reverseTimer = setTimeout(async () => {
    const r = await api.geo.reverse(point);
    if (seq !== reverseSeq) return;
    const sel = get().selection;
    if (!sel || sel.point !== point) return;
    if (r.ok && r.value) set({ selection: { ...sel, name: r.value.name, detail: r.value.detail, resolving: false } });
    else set({ selection: { ...sel, resolving: false, name: undefined, detail: r.ok ? "No address here" : "Address lookup unavailable" } });
  }, 450);
}

export function clearSelection() {
  set({ selection: null });
}

export function flyTo(point: LatLng, zoom?: number) {
  set({ mapCommand: { kind: "fly", point, zoom, id: Date.now() + Math.random() } });
}
export function fitBounds(bbox: [number, number, number, number]) {
  set({ mapCommand: { kind: "fit", bbox, id: Date.now() + Math.random() } });
}
export function fitPoints(points: LatLng[]) {
  if (points.length === 1) return flyTo(points[0], 14);
  if (points.length > 1) set({ mapCommand: { kind: "fitPoints", points, id: Date.now() + Math.random() } });
}
export function zoomBy(delta: number) {
  set({ mapCommand: { kind: "zoom", delta, id: Date.now() + Math.random() } });
}

// ------------------------------------------------------------------ route
let routeSeq = 0;
let stopSeq = 0;
const newStopId = () => `s${Date.now().toString(36)}${(++stopSeq).toString(36)}`;

export function setRoute(patch: Partial<RouteDraft>, recompute = false) {
  set((s) => ({ route: { ...s.route, ...patch } }));
  if (recompute) void recomputeRoute();
}

export function addStop(point: LatLng, name?: string) {
  const { route } = get();
  if (route.stops.length >= 25) return toast("Routes can have up to 25 stops.", "error");
  setRoute({ stops: [...route.stops, { id: newStopId(), point, name }], savedId: null }, true);
  if (!name) {
    void api.geo.reverse(point).then((r) => {
      if (!r.ok || !r.value) return;
      set((s) => ({
        route: { ...s.route, stops: s.route.stops.map((x) => (x.point === point && !x.name ? { ...x, name: r.value!.name } : x)) },
      }));
    });
  }
}

export function moveStop(id: string, point: LatLng) {
  setRoute({ stops: get().route.stops.map((s) => (s.id === id ? { ...s, point, name: undefined } : s)), savedId: null }, true);
}

export function removeStop(id: string) {
  setRoute({ stops: get().route.stops.filter((s) => s.id !== id), savedId: null }, true);
}

export function reorderStop(id: string, dir: -1 | 1) {
  const stops = get().route.stops.slice();
  const i = stops.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= stops.length) return;
  [stops[i], stops[j]] = [stops[j], stops[i]];
  setRoute({ stops, savedId: null }, true);
}

export function clearRoute() {
  setRoute({ stops: [], computed: null, error: null, name: null, savedId: null });
}

export async function recomputeRoute() {
  const { route } = get();
  const seq = ++routeSeq;
  if (route.stops.length < 2) {
    setRoute({ computed: null, computing: false, error: null });
    return;
  }
  setRoute({ computing: true, error: null });
  const r = await api.geo.route(
    route.stops.map((s) => s.point),
    route.mode,
    route.pathMode,
  );
  if (seq !== routeSeq) return;
  if (r.ok) setRoute({ computed: r.value, computing: false, error: null });
  else if (r.code !== "cancelled") setRoute({ computed: null, computing: false, error: r.error });
}

export function routeSpeedKmh() {
  const { route } = get();
  return speedKmh(route.mode, route.customKmh);
}

// ------------------------------------------------------------- simulation
async function confirmStart(what: string): Promise<boolean> {
  const { settings } = get();
  const device = selectedDevice();
  if (!settings.location.confirmBeforeStart || !device) return true;
  const r = await confirmAction({
    title: device.isTest ? "Start a test simulation?" : `Simulate location on ${device.name}?`,
    body: device.isTest
      ? `${what} will run on the loopback test adapter. No real device location changes.`
      : `${what} will replace the location ${device.name} reports to apps until you press Stop. Only continue on a device you own or are authorized to test.`,
    confirmLabel: "Start simulation",
    checkbox: "Don't ask again",
  });
  if (r.ok && r.checked) void updateSettings({ location: { confirmBeforeStart: false } });
  return r.ok;
}

export async function startLocation() {
  const { selection } = get();
  const device = selectedDevice();
  if (!selection) return toast("Choose a location on the map first.", "error");
  if (!device) return toast("Connect a device or simulator first.", "error");
  const sameDeviceActive = get().sim.deviceId === device.id && get().sim.phase === "active" && get().sim.kind === "location";
  if (!sameDeviceActive && !(await confirmStart("This location"))) return;
  const r = await api.simulation.startLocation({ deviceId: device.id, point: selection.point, name: selection.name });
  if (r.ok) {
    if (selection.favoriteId) void api.library.touchFavorite(selection.favoriteId);
    toast(device.isTest ? "Test adapter accepted the location (no real device)." : `Location applied on ${device.name}.`, "success");
  } else if (r.code !== "cancelled") toast(r.error, "error");
}

export async function startRoute() {
  const { route } = get();
  const device = selectedDevice();
  if (!device) return toast("Connect a device or simulator first.", "error");
  if (!route.computed) return toast("Add a start and destination to build a route.", "error");
  if (!(await confirmStart("This route"))) return;
  const r = await api.simulation.startRoute({
    deviceId: device.id,
    name: route.name ?? undefined,
    stops: route.stops,
    geometry: route.computed.geometry,
    mode: route.mode,
    speedKmh: routeSpeedKmh(),
    loop: route.loop,
  });
  if (r.ok) toast(device.isTest ? "Route running on the test adapter (no real device)." : `Route started on ${device.name}.`, "success");
  else if (r.code !== "cancelled") toast(r.error, "error");
}

export async function stopSimulation() {
  const { sim } = get();
  if (sim.phase === "idle") return;
  const r = await api.simulation.stop();
  if (!r.ok) return toast(r.error, "error");
  if (sim.phase === "failed") return;
  const after = await api.simulation.state();
  if (after.note) toast(after.note);
  else toast(sim.isTest ? "Test simulation stopped." : "Simulation stopped and the device location was restored.", "success");
}
