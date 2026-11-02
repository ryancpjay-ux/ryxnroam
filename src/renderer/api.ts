import type { RoamApi } from "../shared/ipc";

declare global {
  interface Window {
    roam?: RoamApi;
    roamPlatform?: string;
  }
}

/** The preload bridge. Absent only if the page is opened outside the app. */
export const api = window.roam as RoamApi;
export const platform = window.roamPlatform ?? "unknown";
export const hasBridge = !!window.roam;
