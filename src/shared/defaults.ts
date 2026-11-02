import type { Settings } from "./types";

export const ONBOARDING_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  general: {
    launchAtStartup: false,
    theme: "dark",
    placeLanguage: "local",
    notifications: true,
    defaultMapStyle: "auto",
    showIntro: true,
  },
  devices: {
    autoRefresh: true,
    refreshIntervalSec: 4,
    pymobiledevice3Path: "",
    adbPath: "",
    iosTunnel: "auto",
    showTestAdapter: false,
  },
  location: {
    defaultMode: "walk",
    customSpeedKmh: 30,
    units: "metric",
    coordFormat: "decimal",
    keepAwake: true,
    confirmBeforeStart: true,
    updateIntervalMs: 1000,
    defaultPathMode: "roads",
  },
  onboarding: {
    completedAt: null,
    version: ONBOARDING_VERSION,
  },
};

/** Languages offered for place names in search results and map labels. */
export const PLACE_LANGUAGES: { id: string; label: string }[] = [
  { id: "local", label: "Local names" },
  { id: "en", label: "English" },
  { id: "de", label: "Deutsch" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
  { id: "it", label: "Italiano" },
  { id: "ja", label: "日本語" },
  { id: "zh", label: "中文" },
];

/** Photon supports a smaller language set; others fall back to default. */
export const PHOTON_LANGS = new Set(["en", "de", "fr", "it"]);
