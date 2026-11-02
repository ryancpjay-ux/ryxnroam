import type { AdapterStatus, DeviceInfo, LatLng, Settings } from "../../shared/types";
import { run, which } from "../exec";
import { classifyToolError, type ApplyResult, type DeviceAdapter, type LocationSession } from "./adapter";

/**
 * Apple's Simulator via `xcrun simctl location` (Xcode 14+).
 * Documented by Apple; requires a full Xcode install, not just Command Line Tools.
 */
export class IosSimulatorAdapter implements DeviceAdapter {
  readonly id = "ios-simulator" as const;
  readonly label = "iOS Simulator";

  platformSupported(): boolean {
    return process.platform === "darwin";
  }

  async probe(_settings: Settings, signal: AbortSignal): Promise<AdapterStatus> {
    const base = { adapterId: this.id, label: this.label, checkedAt: Date.now() };
    if (!this.platformSupported())
      return { ...base, platformSupported: false, available: false, detail: "Apple Simulator runs only on macOS." };
    const xcrun = which("xcrun");
    if (!xcrun)
      return {
        ...base,
        platformSupported: true,
        available: false,
        detail: "xcrun was not found.",
        guidance: "Install Xcode from the App Store, open it once, then press Refresh.",
      };
    const res = await run(xcrun, ["simctl", "help", "location"], { timeoutMs: 8000, signal, quiet: true }).catch(
      (e: Error) => ({ code: -1, stdout: "", stderr: e.message, timedOut: false, signal: null }),
    );
    if (res.code !== 0) {
      const clt = /unable to find utility "simctl"/i.test(res.stderr);
      return {
        ...base,
        platformSupported: true,
        available: false,
        toolPath: xcrun,
        detail: clt
          ? "Only the Command Line Tools are selected; simctl ships with full Xcode."
          : "simctl location is unavailable (Xcode 14 or later is required).",
        guidance: clt
          ? "Install Xcode, then run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
          : "Update Xcode to version 14 or later.",
      };
    }
    const ver = await run(xcrun, ["xcodebuild", "-version"], { timeoutMs: 8000, signal, quiet: true }).catch(() => null);
    return {
      ...base,
      platformSupported: true,
      available: true,
      toolPath: xcrun,
      toolVersion: ver?.stdout.split("\n")[0]?.trim() || undefined,
      detail: "simctl is available. Boot a simulator to see it here.",
    };
  }

  async discover(_settings: Settings, signal: AbortSignal): Promise<DeviceInfo[]> {
    const xcrun = which("xcrun");
    if (!xcrun) return [];
    const res = await run(xcrun, ["simctl", "list", "devices", "booted", "--json"], {
      timeoutMs: 10000,
      signal,
      quiet: true,
    });
    if (res.code !== 0) throw new Error(res.stderr.trim() || "simctl list failed");
    return parseSimctlDevices(res.stdout);
  }

  openSession(device: DeviceInfo): LocationSession {
    return new SimctlSession(device.nativeId);
  }
}

export function parseSimctlDevices(json: string): DeviceInfo[] {
  const parsed = JSON.parse(json) as { devices?: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]> };
  const out: DeviceInfo[] = [];
  for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
    const m = runtime.match(/SimRuntime\.([A-Za-z]+)-([\d-]+)$/);
    const osName = m?.[1] ?? "iOS";
    const osVersion = m?.[2]?.replace(/-/g, ".");
    for (const d of list) {
      if (d.state !== "Booted") continue;
      out.push({
        id: `ios-simulator:${d.udid}`,
        adapterId: "ios-simulator",
        nativeId: d.udid,
        name: d.name,
        model: "Simulator",
        osName,
        osVersion,
        connection: "local",
        state: d.isAvailable === false ? "unsupported" : "connected",
        stateDetail: d.isAvailable === false ? "Simulator runtime is unavailable." : undefined,
        restoresOnStop: true,
      });
    }
  }
  return out;
}

class SimctlSession implements LocationSession {
  readonly capabilities = { continuous: true, minIntervalMs: 250, playback: false, restoresOnClear: true };
  onLost = null;
  constructor(private readonly udid: string) {}

  private async simctl(args: string[], signal?: AbortSignal): Promise<ApplyResult> {
    const xcrun = which("xcrun");
    if (!xcrun) return { ok: false, error: { code: "tool-missing", message: "xcrun is no longer available." } };
    try {
      const res = await run(xcrun, ["simctl", "location", this.udid, ...args], { timeoutMs: 10000, signal, quiet: args[0] === "set" });
      if (res.timedOut) return { ok: false, error: { code: "timeout", message: "Simulator did not respond in time." } };
      if (res.code === 0) return { ok: true, confirmation: "exit-ok" };
      return { ok: false, error: classifyToolError(res.stderr || res.stdout, "Simulator rejected the location.") };
    } catch (e) {
      return { ok: false, error: { code: "internal", message: (e as Error).message } };
    }
  }

  apply(p: LatLng, signal: AbortSignal): Promise<ApplyResult> {
    return this.simctl(["set", `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`], signal);
  }

  clear(): Promise<ApplyResult> {
    return this.simctl(["clear"]);
  }

  async dispose(): Promise<void> {}
}
