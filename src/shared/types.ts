/** Domain types shared by the main process, preload bridge and renderer. */

export interface LatLng {
  lat: number;
  lng: number;
}

export type AdapterId = "ios-simulator" | "ios-device" | "android-emulator" | "test";

/** Connection state exactly as the UI must present it. */
export type ConnectionState =
  | "connected"
  | "disconnected"
  | "connecting"
  | "unsupported"
  | "permission-required";

export interface DeviceInfo {
  /** Stable id: `${adapterId}:${nativeId}` */
  id: string;
  adapterId: AdapterId;
  nativeId: string;
  name: string;
  model?: string;
  osName?: string;
  osVersion?: string;
  connection?: "usb" | "network" | "local";
  state: ConnectionState;
  /** Human explanation for non-connected states. */
  stateDetail?: string;
  /** Short actionable guidance (what the user can do). */
  guidance?: string;
  /** Optional preparation the user may trigger explicitly. */
  actions?: DeviceAction[];
  /** True for the loopback test adapter; never a real device. */
  isTest?: boolean;
  /** Whether stopping restores the device's real location. */
  restoresOnStop: boolean;
  /** iPhone/iPad only: whether the device accepts connections over Wi-Fi (Finder's “Show … when on Wi-Fi”). */
  wifi?: "on" | "off";
}

export interface DeviceAction {
  id: "mount-ddi" | "recheck" | "enable-wifi" | "disable-wifi";
  label: string;
  description: string;
}

export interface AdapterStatus {
  adapterId: AdapterId;
  label: string;
  /** Supported on this operating system at all. */
  platformSupported: boolean;
  /** Required tooling found and runnable. */
  available: boolean;
  toolPath?: string;
  toolVersion?: string;
  detail: string;
  guidance?: string;
  checkedAt: number;
}

export interface DevicesSnapshot {
  devices: DeviceInfo[];
  adapters: AdapterStatus[];
  scanning: boolean;
  lastScanAt: number | null;
}

export type MovementMode = "walk" | "cycle" | "drive" | "custom";
export type PathMode = "roads" | "direct";

export type SimPhase = "idle" | "starting" | "active" | "paused" | "stopping" | "failed";

/** How the app knows the device accepted the location. */
export type Confirmation =
  | "exit-ok" /* tool exited successfully after applying */
  | "holding" /* tool reported it applied and is holding the location */
  | "playback" /* device is replaying a route; per-point confirmation unavailable */
  | "test"; /* loopback test adapter, no real device */

export interface SimError {
  code:
    | "device-disconnected"
    | "tool-missing"
    | "permission-required"
    | "ddi-required"
    | "rejected"
    | "timeout"
    | "unsupported"
    | "internal";
  message: string;
  detail?: string;
}

export interface RouteProgress {
  totalMeters: number;
  traveledMeters: number;
  speedMps: number;
  mode: MovementMode;
  /** 0..1 */
  progress: number;
  remainingMs: number;
  /** Estimated completion as epoch ms (null while paused). */
  etaAt: number | null;
  loop: boolean;
  laps: number;
  stops: RouteStop[];
  geometry: LatLng[];
}

export interface SimulationState {
  phase: SimPhase;
  kind: "location" | "route" | null;
  deviceId: string | null;
  deviceName: string | null;
  adapterId: AdapterId | null;
  isTest: boolean;
  /** Last position the device-level tool confirmed (see `confirmation`). */
  appliedPosition: LatLng | null;
  /** Position the route engine expects right now (may lead `appliedPosition`). */
  enginePosition: LatLng | null;
  targetName: string | null;
  confirmation: Confirmation | null;
  route: RouteProgress | null;
  startedAt: number | null;
  error: SimError | null;
  /** Informational note, e.g. emulator keeps last fix after stop. */
  note: string | null;
  scheduleId: string | null;
}

export interface RouteStop {
  id: string;
  point: LatLng;
  name?: string;
}

export interface ComputedRoute {
  geometry: LatLng[];
  distanceMeters: number;
  /** Provider's own duration estimate (not used for simulation timing). */
  providerDurationS: number | null;
  provider: "osrm" | "direct";
  /** Set when road routing failed and we fell back to straight lines. */
  fallbackReason?: string;
}

export interface Favorite {
  id: string;
  name: string;
  point: LatLng;
  address?: string;
  group?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface SavedRoute {
  id: string;
  name: string;
  stops: RouteStop[];
  mode: MovementMode;
  customSpeedKmh?: number;
  pathMode: PathMode;
  loop: boolean;
  geometry?: LatLng[];
  distanceMeters?: number;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryEntry {
  id: string;
  kind: "location" | "route";
  label: string;
  point: LatLng;
  deviceName: string;
  adapterId: AdapterId;
  isTest: boolean;
  startedAt: number;
  endedAt: number | null;
  outcome: "running" | "stopped" | "completed" | "failed";
  error?: string;
  distanceMeters?: number;
  scheduleId?: string;
}

export type ScheduleStatus =
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "missed"
  | "cancelled";

export interface Schedule {
  id: string;
  target: { kind: "favorite"; favoriteId: string } | { kind: "route"; routeId: string };
  targetLabel: string;
  deviceId: string;
  deviceName: string;
  startAt: number;
  durationMinutes: number | null;
  consentAt: number;
  status: ScheduleStatus;
  createdAt: number;
  ranAt?: number;
  finishedAt?: number;
  outcomeDetail?: string;
}

export type ThemePref = "dark" | "light" | "system";
export type MapStyleId = "auto" | "dark" | "light" | "streets" | "bright";
export type Units = "metric" | "imperial";
export type CoordFormat = "decimal" | "dms";

export interface Settings {
  general: {
    launchAtStartup: boolean;
    theme: ThemePref;
    placeLanguage: string; // "local" | ISO 639-1 code
    notifications: boolean;
    defaultMapStyle: MapStyleId;
    showIntro: boolean;
  };
  devices: {
    autoRefresh: boolean;
    refreshIntervalSec: number;
    pymobiledevice3Path: string;
    adbPath: string;
    iosTunnel: "auto" | "userspace" | "tunneld";
    showTestAdapter: boolean;
  };
  location: {
    defaultMode: MovementMode;
    customSpeedKmh: number;
    units: Units;
    coordFormat: CoordFormat;
    keepAwake: boolean;
    confirmBeforeStart: boolean;
    updateIntervalMs: number;
    defaultPathMode: PathMode;
  };
  onboarding: {
    completedAt: number | null;
    version: number;
  };
}

export interface Library {
  favorites: Favorite[];
  routes: SavedRoute[];
}

export interface GeocodeResult {
  id: string;
  name: string;
  detail: string;
  point: LatLng;
  kind?: string;
  bbox?: [number, number, number, number];
}

export interface AppInfo {
  name: string;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  electron: string;
  chrome: string;
  node: string;
  buildDate: string;
  commit: string;
  packaged: boolean;
  userDataPath: string;
}

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "unavailable"; detail: string }
  | { state: "up-to-date"; version: string }
  | { state: "available"; version: string; notes?: string }
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

export interface LogLine {
  t: number;
  level: "info" | "warn" | "error";
  scope: string;
  msg: string;
}
