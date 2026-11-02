import type { AdapterStatus, DeviceInfo, LatLng, Settings } from "../../shared/types";
import { run, which } from "../exec";
import { classifyToolError, type ApplyResult, type DeviceAdapter, type LocationSession } from "./adapter";

/**
 * Android Emulator via `adb emu geo fix <lng> <lat>` (documented emulator
 * console command). Physical Android devices are listed but not driven:
 * Android only accepts mock locations from an app the user selects under
 * Developer options › Select mock location app, and ryxnroam does not install one.
 */
export class AndroidEmulatorAdapter implements DeviceAdapter {
  readonly id = "android-emulator" as const;
  readonly label = "Android Emulator (adb)";

  platformSupported(): boolean {
    return ["darwin", "win32", "linux"].includes(process.platform);
  }

  private adb(settings: Settings): string | null {
    return which(settings.devices.adbPath.trim() || "adb");
  }

  async probe(settings: Settings, signal: AbortSignal): Promise<AdapterStatus> {
    const base = { adapterId: this.id, label: this.label, platformSupported: this.platformSupported(), checkedAt: Date.now() };
    const adb = this.adb(settings);
    if (!adb)
      return {
        ...base,
        available: false,
        detail: settings.devices.adbPath ? `adb was not found at ${settings.devices.adbPath}.` : "adb (Android platform-tools) is not installed.",
        guidance: "Install Android Studio or the standalone platform-tools, then press Refresh.",
      };
    const ver = await run(adb, ["version"], { timeoutMs: 8000, signal, quiet: true }).catch(() => null);
    return {
      ...base,
      available: true,
      toolPath: adb,
      toolVersion: ver?.stdout.split("\n")[0]?.replace("Android Debug Bridge version", "adb").trim(),
      detail: "adb is available. Start an emulator from Android Studio to see it here.",
    };
  }

  async discover(settings: Settings, signal: AbortSignal): Promise<DeviceInfo[]> {
    const adb = this.adb(settings);
    if (!adb) return [];
    const res = await run(adb, ["devices", "-l"], { timeoutMs: 10000, signal, quiet: true });
    if (res.code !== 0) throw new Error(res.stderr.trim() || "adb devices failed");
    const devices = parseAdbDevices(res.stdout);
    for (const d of devices) {
      if (d.state !== "connected" || !d.nativeId.startsWith("emulator-")) continue;
      const name = await run(adb, ["-s", d.nativeId, "emu", "avd", "name"], { timeoutMs: 5000, signal, quiet: true }).catch(() => null);
      const avd = name?.code === 0 ? name.stdout.split(/\r?\n/)[0]?.trim() : "";
      if (avd && avd !== "OK") d.name = avd.replace(/_/g, " ");
    }
    return devices;
  }

  openSession(device: DeviceInfo, settings: Settings): LocationSession {
    const adb = this.adb(settings);
    if (!adb) throw new Error("adb is not available");
    return new GeoFixSession(adb, device.nativeId);
  }
}

export function parseAdbDevices(stdout: string): DeviceInfo[] {
  const out: DeviceInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(device|offline|unauthorized|no permissions|authorizing|connecting)\b(.*)$/);
    if (!m) continue;
    const [, serial, status, rest] = m;
    const model = rest.match(/model:(\S+)/)?.[1]?.replace(/_/g, " ");
    const emulator = serial.startsWith("emulator-");
    const dev: DeviceInfo = {
      id: `android-emulator:${serial}`,
      adapterId: "android-emulator",
      nativeId: serial,
      name: emulator ? `Android Emulator (${serial.replace("emulator-", "port ")})` : model || serial,
      model,
      osName: "Android",
      connection: emulator ? "local" : "usb",
      state: "connected",
      // The emulator has no real GPS; it keeps the last fix after we stop.
      restoresOnStop: false,
    };
    if (!emulator) {
      dev.state = "unsupported";
      dev.stateDetail = "Physical Android devices need a mock-location app.";
      dev.guidance =
        "Android only accepts simulated locations from an app chosen under Developer options › Select mock location app. ryxnroam drives emulators only.";
    } else if (status === "unauthorized" || status === "no permissions") {
      dev.state = "permission-required";
      dev.stateDetail = "adb is not authorized for this emulator.";
      dev.guidance = "Accept the USB debugging prompt in the emulator, then press Refresh.";
    } else if (status === "offline") {
      dev.state = "disconnected";
      dev.stateDetail = "The emulator is offline.";
    } else if (status !== "device") {
      dev.state = "connecting";
      dev.stateDetail = `adb reports “${status}”.`;
    }
    out.push(dev);
  }
  return out;
}

class GeoFixSession implements LocationSession {
  readonly capabilities = { continuous: true, minIntervalMs: 250, playback: false, restoresOnClear: false };
  onLost = null;
  constructor(
    private readonly adb: string,
    private readonly serial: string,
  ) {}

  async apply(p: LatLng, signal: AbortSignal): Promise<ApplyResult> {
    try {
      // geo fix takes longitude first.
      const res = await run(this.adb, ["-s", this.serial, "emu", "geo", "fix", p.lng.toFixed(7), p.lat.toFixed(7)], {
        timeoutMs: 8000,
        signal,
        quiet: true,
      });
      if (res.timedOut) return { ok: false, error: { code: "timeout", message: "The emulator did not respond in time." } };
      const out = `${res.stdout}\n${res.stderr}`;
      if (res.code === 0 && !/KO:|error/i.test(out)) return { ok: true, confirmation: "exit-ok" };
      return { ok: false, error: classifyToolError(out, "The emulator rejected the location.") };
    } catch (e) {
      return { ok: false, error: { code: "internal", message: (e as Error).message } };
    }
  }

  /** Emulators have no real position to restore; stopping simply stops sending fixes. */
  async clear(): Promise<ApplyResult> {
    return { ok: true, confirmation: "exit-ok" };
  }

  async dispose(): Promise<void> {}
}
