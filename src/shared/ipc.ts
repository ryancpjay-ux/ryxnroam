import type {
  AppInfo,
  ComputedRoute,
  DeviceAction,
  DevicesSnapshot,
  Favorite,
  GeocodeResult,
  HistoryEntry,
  LatLng,
  Library,
  LogLine,
  MovementMode,
  PathMode,
  RouteStop,
  SavedRoute,
  Schedule,
  Settings,
  SimulationState,
  UpdateStatus,
} from "./types";

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface StartLocationRequest {
  deviceId: string;
  point: LatLng;
  name?: string;
}

export interface StartRouteRequest {
  deviceId: string;
  name?: string;
  stops: RouteStop[];
  geometry: LatLng[];
  mode: MovementMode;
  speedKmh: number;
  loop: boolean;
}

export interface NewSchedule {
  target: Schedule["target"];
  deviceId: string;
  startAt: number;
  durationMinutes: number | null;
  consent: true;
}

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string; code?: string };

/** The API exposed on `window.roam` by the preload script. */
export interface RoamApi {
  app: {
    info(): Promise<AppInfo>;
    window(action: "minimize" | "maximize" | "close"): void;
    openExternal(url: string): Promise<void>;
    onWindowState(cb: (s: { maximized: boolean; focused: boolean }) => void): () => void;
    onCommand(cb: (cmd: "open-settings" | "stop-simulation") => void): () => void;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: DeepPartial<Settings>): Promise<Settings>;
    onChange(cb: (s: Settings) => void): () => void;
  };
  devices: {
    snapshot(): Promise<DevicesSnapshot>;
    refresh(): Promise<DevicesSnapshot>;
    runAction(deviceId: string, action: DeviceAction["id"]): Promise<Result<string>>;
    onChange(cb: (s: DevicesSnapshot) => void): () => void;
  };
  simulation: {
    state(): Promise<SimulationState>;
    startLocation(req: StartLocationRequest): Promise<Result>;
    startRoute(req: StartRouteRequest): Promise<Result>;
    pause(): Promise<Result>;
    resume(): Promise<Result>;
    setSpeed(kmh: number, mode: MovementMode): Promise<Result>;
    stop(): Promise<Result>;
    dismissError(): Promise<void>;
    onState(cb: (s: SimulationState) => void): () => void;
  };
  geo: {
    search(query: string, opts: { bias?: LatLng; submit?: boolean }): Promise<Result<GeocodeResult[]>>;
    reverse(point: LatLng): Promise<Result<GeocodeResult | null>>;
    route(stops: LatLng[], mode: MovementMode, pathMode: PathMode): Promise<Result<ComputedRoute>>;
  };
  library: {
    get(): Promise<Library>;
    saveFavorite(f: Omit<Favorite, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<Favorite>;
    deleteFavorite(id: string): Promise<void>;
    touchFavorite(id: string): Promise<void>;
    saveRoute(r: Omit<SavedRoute, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<SavedRoute>;
    deleteRoute(id: string): Promise<void>;
    exportRouteGpx(id: string): Promise<Result<string>>;
    onChange(cb: (l: Library) => void): () => void;
  };
  history: {
    list(): Promise<HistoryEntry[]>;
    clear(): Promise<void>;
    onChange(cb: (h: HistoryEntry[]) => void): () => void;
  };
  schedules: {
    list(): Promise<Schedule[]>;
    create(s: NewSchedule): Promise<Result<Schedule>>;
    cancel(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    onChange(cb: (s: Schedule[]) => void): () => void;
  };
  data: {
    exportAll(): Promise<Result<string>>;
    importAll(): Promise<Result<{ favorites: number; routes: number }>>;
  };
  updates: {
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    download(): Promise<void>;
    install(): Promise<void>;
    onStatus(cb: (s: UpdateStatus) => void): () => void;
  };
  diagnostics: {
    logs(): Promise<LogLine[]>;
    report(): Promise<string>;
    copy(text: string): Promise<void>;
  };
}

/** Invoke channels (renderer → main). */
export const CH = {
  appInfo: "app:info",
  appWindow: "app:window",
  appOpenExternal: "app:open-external",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  devicesSnapshot: "devices:snapshot",
  devicesRefresh: "devices:refresh",
  devicesAction: "devices:action",
  simState: "sim:state",
  simStartLocation: "sim:start-location",
  simStartRoute: "sim:start-route",
  simPause: "sim:pause",
  simResume: "sim:resume",
  simSetSpeed: "sim:set-speed",
  simStop: "sim:stop",
  simDismiss: "sim:dismiss",
  geoSearch: "geo:search",
  geoReverse: "geo:reverse",
  geoRoute: "geo:route",
  libGet: "lib:get",
  libSaveFavorite: "lib:save-favorite",
  libDeleteFavorite: "lib:delete-favorite",
  libTouchFavorite: "lib:touch-favorite",
  libSaveRoute: "lib:save-route",
  libDeleteRoute: "lib:delete-route",
  libExportRouteGpx: "lib:export-route-gpx",
  historyList: "history:list",
  historyClear: "history:clear",
  schedList: "sched:list",
  schedCreate: "sched:create",
  schedCancel: "sched:cancel",
  schedRemove: "sched:remove",
  dataExport: "data:export",
  dataImport: "data:import",
  updStatus: "upd:status",
  updCheck: "upd:check",
  updDownload: "upd:download",
  updInstall: "upd:install",
  diagLogs: "diag:logs",
  diagReport: "diag:report",
  diagCopy: "diag:copy",
} as const;

/** Event channels (main → renderer). */
export const EV = {
  windowState: "ev:window-state",
  command: "ev:command",
  settings: "ev:settings",
  devices: "ev:devices",
  simulation: "ev:simulation",
  library: "ev:library",
  history: "ev:history",
  schedules: "ev:schedules",
  updates: "ev:updates",
} as const;
