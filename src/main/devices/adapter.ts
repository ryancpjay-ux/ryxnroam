import type { AdapterId, AdapterStatus, Confirmation, DeviceAction, DeviceInfo, LatLng, SimError, Settings } from "../../shared/types";

/**
 * Contract between the simulation engine and a platform integration.
 *
 * Adapters must only resolve `apply` after the underlying tool confirmed the
 * location (or report exactly how far confirmation goes via `confirmation`).
 * They must never claim success for something they could not verify.
 */
export interface DeviceAdapter {
  readonly id: AdapterId;
  readonly label: string;
  /** Whether this OS can host the integration at all. */
  platformSupported(): boolean;
  /** Check tooling. Cheap enough to call every ~30 s. */
  probe(settings: Settings, signal: AbortSignal): Promise<AdapterStatus>;
  /** List devices. Only called when `probe` reported the tool available. */
  discover(settings: Settings, signal: AbortSignal): Promise<DeviceInfo[]>;
  /** Open a session that can move one device. */
  openSession(device: DeviceInfo, settings: Settings): LocationSession;
  /** Explicit, user-triggered preparation steps (e.g. mounting the developer disk image). */
  runAction?(device: DeviceInfo, action: DeviceAction["id"], settings: Settings): Promise<string>;
}

export interface ApplyOk {
  ok: true;
  confirmation: Confirmation;
}
export interface ApplyFail {
  ok: false;
  error: SimError;
}
export type ApplyResult = ApplyOk | ApplyFail;

export interface SessionCapabilities {
  /** Can accept frequent `apply` calls (used for smooth route movement). */
  continuous: boolean;
  /** Minimum spacing between `apply` calls in ms. */
  minIntervalMs: number;
  /** Supports handing the whole timed route to the device (GPX playback). */
  playback: boolean;
  /** Whether `clear` returns the device to its real location. */
  restoresOnClear: boolean;
}

export interface LocationSession {
  readonly capabilities: SessionCapabilities;
  apply(point: LatLng, signal: AbortSignal): Promise<ApplyResult>;
  /** Replay a timed GPX on the device (only when `capabilities.playback`). */
  play?(gpx: string, signal: AbortSignal): Promise<ApplyResult>;
  clear(): Promise<ApplyResult>;
  /** Release processes/resources. Must be safe to call more than once. */
  dispose(): Promise<void>;
  /** Fired if the session dies unexpectedly (tool exited, device unplugged). */
  onLost: ((error: SimError) => void) | null;
}

export function classifyToolError(output: string, fallback = "The device tool rejected the request."): SimError {
  const text = output.trim();
  const tail = text.split("\n").slice(-6).join("\n").slice(-800);
  const has = (re: RegExp) => re.test(text);
  if (has(/developer ?mode/i) && has(/disabled|not enabled|enable/i))
    return {
      code: "permission-required",
      message: "Developer Mode is off on this device.",
      detail: "Enable it in Settings › Privacy & Security › Developer Mode, restart the device, then try again.",
    };
  if (has(/PairingDialogResponsePending|NotPaired|PasswordProtected|pairing|trust/i))
    return {
      code: "permission-required",
      message: "The device has not trusted this computer.",
      detail: "Unlock the device and tap Trust when prompted, then try again.",
    };
  if (has(/DeveloperDiskImage|InvalidService|mount|DDI|personalized/i))
    return {
      code: "ddi-required",
      message: "The developer disk image is not mounted.",
      detail: "Use “Mount developer disk image” in the device panel, then try again.",
    };
  if (has(/requires (root|admin)|Access is denied|Permission denied|run-as administrator|sudo/i))
    return {
      code: "permission-required",
      message: "The device tool needs elevated privileges for this connection.",
      detail: tail,
    };
  if (has(/No ?Device|not found|Unable to boot|Invalid device|ConnectionFailed|device offline|disconnected/i))
    return { code: "device-disconnected", message: "The device is no longer reachable.", detail: tail };
  return { code: "rejected", message: fallback, detail: tail || undefined };
}
