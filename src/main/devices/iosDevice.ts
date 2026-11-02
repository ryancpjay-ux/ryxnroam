import { closeSync, existsSync, openSync, readSync } from "node:fs";
import path from "node:path";
import type { AdapterStatus, DeviceAction, DeviceInfo, LatLng, SimError, Settings } from "../../shared/types";
import { JsonLineProcess, run, which, type JsonMessage } from "../exec";
import { logger } from "../log";
import { classifyToolError, type ApplyResult, type DeviceAdapter, type LocationSession } from "./adapter";

const log = logger("ios-device");

/**
 * Physical iPhone/iPad through pymobiledevice3 — a separately installed,
 * GPL-3.0 tool that speaks Apple's developer services (the same services Xcode
 * uses). ryxnroam never links it; it runs it as separate processes.
 *
 *  - iOS 17+: helpers/ios_location_helper.py (GPL-3.0, run with pymobiledevice3's
 *    own Python) holds one DVT LocationSimulation channel open over the tunnel
 *    and keeps that tunnel serviced. The CLI's `simulate-location set` blocks
 *    its event loop while "holding", so the default userspace tunnel goes
 *    silent and the device drops the location after ~30 s.
 *  - iOS ≤ 16: `developer simulate-location set|clear` (DTSimulateLocation),
 *    which persists without a held connection.
 *
 * Requirements the user controls: Developer Mode on, device trusts this
 * computer, developer disk image mounted. Nothing here bypasses any of them.
 */

interface Tool {
  cmd: string;
  prefix: string[];
  display: string;
}

const HELPER_NAME = "ios_location_helper.py";

/** The helper ships in app resources when packaged and in helpers/ in a checkout. */
export function helperScriptPath(): string | null {
  const resources = (process as { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resources && path.join(resources, "helpers", HELPER_NAME),
    path.join(__dirname, "../../helpers", HELPER_NAME),
    path.join(__dirname, "../../../helpers", HELPER_NAME),
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** The Python interpreter a pymobiledevice3 launcher runs with, read from its shebang. */
export function pythonFromLauncher(launcher: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(launcher, "r");
    const buf = Buffer.alloc(512);
    const head = buf.subarray(0, readSync(fd, buf, 0, 512, 0)).toString("utf8");
    const m = head.match(/^#!\s*(\S+)(?:[ \t]+(\S+))?/);
    if (!m) return null;
    if (path.basename(m[1]) === "env") return m[2] ? which(m[2]) : null;
    return existsSync(m[1]) ? m[1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function resolvePmd3(settings: Settings): Tool | null {
  const override = settings.devices.pymobiledevice3Path.trim();
  if (override) {
    const p = which(override);
    return p ? { cmd: p, prefix: [], display: p } : null;
  }
  const direct = which("pymobiledevice3");
  if (direct) return { cmd: direct, prefix: [], display: direct };
  return null;
}

async function resolveViaPython(signal: AbortSignal): Promise<Tool | null> {
  for (const py of process.platform === "win32" ? ["py", "python"] : ["python3"]) {
    const exe = which(py);
    if (!exe) continue;
    const res = await run(exe, ["-c", "import pymobiledevice3"], { timeoutMs: 15000, signal, quiet: true }).catch(() => null);
    if (res?.code === 0) return { cmd: exe, prefix: ["-m", "pymobiledevice3"], display: `${exe} -m pymobiledevice3` };
  }
  return null;
}

export function connectionArgs(settings: Settings, udid: string): string[] {
  switch (settings.devices.iosTunnel) {
    case "tunneld":
      return ["--tunnel", udid];
    case "userspace":
      return ["--userspace", "--udid", udid];
    default:
      return ["--udid", udid];
  }
}

interface UsbmuxEntry {
  ConnectionType?: string;
  DeviceName?: string;
  ProductType?: string;
  ProductVersion?: string;
  UniqueDeviceID?: string;
  Identifier?: string;
  DeviceClass?: string;
}

export function parseUsbmuxList(stdout: string): UsbmuxEntry[] {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  const parsed = JSON.parse(stdout.slice(start, end + 1));
  return Array.isArray(parsed) ? parsed : [];
}

export const majorVersion = (v?: string) => Number.parseInt(v ?? "", 10) || 0;

export class IosDeviceAdapter implements DeviceAdapter {
  readonly id = "ios-device" as const;
  readonly label = "iPhone & iPad (pymobiledevice3)";
  private tool: Tool | null = null;
  private python: string | null = null;
  /** Tests substitute a fake helper; normally `python -u helpers/ios_location_helper.py`. */
  helperCommand: ((udid: string, mode: string) => { cmd: string; args: string[] } | null) | null = null;
  private wifiCache = new Map<string, { at: number; value: "on" | "off" | null }>();
  private devModeCache = new Map<string, { at: number; value: boolean | null; error?: SimError }>();

  platformSupported(): boolean {
    return process.platform === "darwin" || process.platform === "win32" || process.platform === "linux";
  }

  async probe(settings: Settings, signal: AbortSignal): Promise<AdapterStatus> {
    const base = { adapterId: this.id, label: this.label, platformSupported: this.platformSupported(), checkedAt: Date.now() };
    this.tool = resolvePmd3(settings) ?? (settings.devices.pymobiledevice3Path ? null : await resolveViaPython(signal));
    if (!this.tool)
      return {
        ...base,
        available: false,
        detail: settings.devices.pymobiledevice3Path
          ? `pymobiledevice3 was not found at ${settings.devices.pymobiledevice3Path}.`
          : "pymobiledevice3 is not installed.",
        guidance:
          "Install it with: python3 -m pip install -U pymobiledevice3 — then press Refresh. Physical devices also need Developer Mode enabled.",
      };
    this.python = this.tool.prefix.includes("-m") ? this.tool.cmd : pythonFromLauncher(this.tool.cmd);
    if (!this.python) this.python = (await resolveViaPython(signal))?.cmd ?? null;
    const ver = await this.exec(["version"], 30000, signal).catch(() => null);
    const version = ver?.code === 0 ? ver.stdout.trim().split("\n").pop()?.trim() : undefined;
    return {
      ...base,
      available: true,
      toolPath: this.tool.display,
      toolVersion: version,
      detail: "pymobiledevice3 is available. Connect a device by USB (or paired Wi-Fi) and unlock it.",
      guidance:
        process.platform === "win32"
          ? "Windows also needs Apple Mobile Device Support (installed with iTunes or Apple Devices)."
          : undefined,
    };
  }

  private exec(args: string[], timeoutMs: number, signal?: AbortSignal, quiet = true) {
    if (!this.tool) return Promise.reject(new Error("pymobiledevice3 unavailable"));
    return run(this.tool.cmd, [...this.tool.prefix, ...args], { timeoutMs, signal, quiet });
  }

  async discover(settings: Settings, signal: AbortSignal): Promise<DeviceInfo[]> {
    if (!this.tool) return [];
    const res = await this.exec(["usbmux", "list"], 20000, signal);
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim().slice(-300) || "usbmux list failed");
    const entries = parseUsbmuxList(res.stdout);
    const isNetwork = (e: UsbmuxEntry) => /network|wifi/i.test(e.ConnectionType ?? "");
    // A device on a cable and on Wi-Fi is listed twice: keep the USB entry, remember it's reachable over Wi-Fi.
    entries.sort((a, b) => Number(isNetwork(a)) - Number(isNetwork(b)));
    const onNetwork = new Set(entries.filter(isNetwork).map((e) => e.UniqueDeviceID || e.Identifier));
    const seen = new Set<string>();
    const devices: DeviceInfo[] = [];
    for (const e of entries) {
      const udid = e.UniqueDeviceID || e.Identifier;
      if (!udid || seen.has(udid)) continue;
      seen.add(udid);
      const major = majorVersion(e.ProductVersion);
      const usb = !isNetwork(e);
      const wifi = onNetwork.has(udid) ? "on" : usb ? await this.wifiState(udid, signal) : "on";
      const dev: DeviceInfo = {
        id: `ios-device:${udid}`,
        adapterId: "ios-device",
        nativeId: udid,
        name: e.DeviceName || e.ProductType || "iOS device",
        model: e.ProductType,
        osName: e.DeviceClass === "iPad" ? "iPadOS" : "iOS",
        osVersion: e.ProductVersion,
        connection: usb ? "usb" : "network",
        state: "connected",
        restoresOnStop: true,
        wifi: wifi ?? undefined,
        actions: [
          ...(usb && wifi === "off"
            ? [
                {
                  id: "enable-wifi" as const,
                  label: "Use over Wi-Fi",
                  description:
                    "Lets ryxnroam reach this device without a cable when both are on the same Wi-Fi — the same setting as Finder's “Show this device when on Wi-Fi”.",
                },
              ]
            : []),
          ...(usb && wifi === "on"
            ? [{ id: "disable-wifi" as const, label: "Turn off Wi-Fi access", description: "Only reach this device over a cable." }]
            : []),
          {
            id: "mount-ddi",
            label: "Mount developer disk image",
            description:
              "Downloads Apple's developer disk image for this iOS version and mounts it. Required once per device boot for location simulation.",
          },
          { id: "recheck", label: "Re-check device", description: "Check Developer Mode and pairing again." },
        ],
      };
      if (major >= 16) {
        const dm = await this.developerMode(settings, udid, signal);
        if (dm.error) {
          dev.state = "permission-required";
          dev.stateDetail = dm.error.message;
          dev.guidance = dm.error.detail;
        } else if (dm.value === false) {
          dev.state = "permission-required";
          dev.stateDetail = "Developer Mode is off.";
          dev.guidance = "On the device: Settings › Privacy & Security › Developer Mode, turn it on and restart.";
        }
      }
      devices.push(dev);
    }
    return devices;
  }

  /** EnableWifiConnections, read over USB (cached briefly; null when it can't be read). */
  private async wifiState(udid: string, signal: AbortSignal): Promise<"on" | "off" | null> {
    const cached = this.wifiCache.get(udid);
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const res = await this.exec(["lockdown", "wifi-connections", "--udid", udid], 20000, signal).catch(() => null);
    const m = res?.code === 0 ? res.stdout.match(/"EnableWifiConnections"\s*:\s*(true|false)/) : null;
    const value = m ? (m[1] === "true" ? "on" : "off") : null;
    this.wifiCache.set(udid, { at: Date.now(), value });
    return value;
  }

  private async developerMode(settings: Settings, udid: string, signal: AbortSignal) {
    const cached = this.devModeCache.get(udid);
    if (cached && Date.now() - cached.at < 60_000) return cached;
    const res = await this.exec(["amfi", "developer-mode-status", "--udid", udid], 25000, signal).catch(
      (e: Error) => ({ code: -1, stdout: "", stderr: e.message, timedOut: false, signal: null }),
    );
    let entry: { at: number; value: boolean | null; error?: SimError };
    if (res.code === 0 && /\btrue\b/i.test(res.stdout)) entry = { at: Date.now(), value: true };
    else if (res.code === 0 && /\bfalse\b/i.test(res.stdout)) entry = { at: Date.now(), value: false };
    else {
      const err = classifyToolError(res.stderr || res.stdout, "Could not read the device's Developer Mode status.");
      // Unknown status is surfaced, not guessed: only pairing/permission problems block the device.
      entry = err.code === "permission-required" ? { at: Date.now(), value: null, error: err } : { at: Date.now(), value: null };
      if (err.code !== "permission-required") log.warn(`developer-mode-status for ${udid}: ${err.detail ?? err.message}`);
    }
    this.devModeCache.set(udid, entry);
    return entry;
  }

  openSession(device: DeviceInfo, settings: Settings): LocationSession {
    if (!this.tool) throw new Error("pymobiledevice3 is not available");
    const modern = majorVersion(device.osVersion) >= 17 || !device.osVersion;
    if (!modern) return new LegacySession(this.tool, device.nativeId, settings);
    const command = this.helperCommand
      ? this.helperCommand(device.nativeId, settings.devices.iosTunnel)
      : this.defaultHelperCommand(device.nativeId, settings.devices.iosTunnel);
    if (!command)
      throw new Error(
        this.python
          ? "ryxnroam's iOS helper script is missing from this installation."
          : "Couldn't find the Python interpreter pymobiledevice3 is installed in. Set the pymobiledevice3 path in Settings › Devices.",
      );
    return new HelperSession(command, device.nativeId);
  }

  private defaultHelperCommand(udid: string, mode: string) {
    const script = helperScriptPath();
    if (!this.python || !script) return null;
    return { cmd: this.python, args: ["-u", script, "--udid", udid, "--mode", mode] };
  }

  async runAction(device: DeviceInfo, action: DeviceAction["id"], settings: Settings): Promise<string> {
    if (action === "recheck") {
      this.devModeCache.delete(device.nativeId);
      this.wifiCache.delete(device.nativeId);
      return "Device will be re-checked on the next scan.";
    }
    if (!this.tool) throw new Error("pymobiledevice3 is not available");
    if (action === "enable-wifi" || action === "disable-wifi") {
      if (device.connection !== "usb") throw new Error(`Connect ${device.name} with a cable to change this setting.`);
      const on = action === "enable-wifi";
      const res = await this.exec(["lockdown", "wifi-connections", "--udid", device.nativeId, on ? "on" : "off"], 30000, undefined, false);
      this.wifiCache.delete(device.nativeId);
      if (res.code !== 0) throw new Error(classifyToolError(res.stderr || res.stdout, "The device didn't accept the Wi-Fi setting.").message);
      return on
        ? `${device.name} can now be used over Wi-Fi. Unplug it any time — it stays available on the same network.`
        : `${device.name} is now reachable over a cable only.`;
    }
    const res = await this.exec(["mounter", "auto-mount", ...connectionArgs(settings, device.nativeId)], 240000, undefined, false);
    const out = (res.stdout + res.stderr).trim();
    if (res.code === 0) return out.split("\n").pop() || "Developer disk image mounted.";
    if (/already mounted/i.test(out)) return "Developer disk image is already mounted.";
    throw new Error(classifyToolError(out, "Mounting the developer disk image failed.").message + (out ? `\n${out.slice(-400)}` : ""));
  }
}

export function classifyHelperError(text: string, fallback?: string): SimError {
  if (/not installed for this Python|ModuleNotFoundError|ImportError|AttributeError: module/i.test(text))
    return {
      code: "tool-missing",
      message: "ryxnroam's iOS helper couldn't use this pymobiledevice3 install.",
      detail: `${text.split("\n").pop()?.slice(0, 300)} — reinstall or update it: python3 -m pip install -U pymobiledevice3`,
    };
  return classifyToolError(text, fallback);
}

/**
 * iOS 17+: one long-lived helper per device. Every `set` is acknowledged by
 * the device over DVT; the helper re-asserts the location every few seconds and
 * reports a dropped connection, which surfaces here as `onLost`.
 */
class HelperSession implements LocationSession {
  readonly capabilities = { continuous: true, minIntervalMs: 500, playback: false, restoresOnClear: true };
  onLost: ((e: SimError) => void) | null = null;
  private proc: JsonLineProcess | null = null;
  private starting: Promise<SimError | null> | null = null;
  /** A helper that reported a lost connection and is being shut down. */
  private retiring: Promise<void> | null = null;

  constructor(
    private readonly command: { cmd: string; args: string[] },
    private readonly udid: string,
  ) {}

  private ensure(signal?: AbortSignal): Promise<SimError | null> {
    if (this.proc && !this.proc.exited) return Promise.resolve(null);
    this.starting ??= this.start(signal).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(signal?: AbortSignal): Promise<SimError | null> {
    const proc = new JsonLineProcess(this.command.cmd, this.command.args);
    const first = await proc.waitForEvent(["ready", "fatal"], 90_000, signal);
    if (first?.event === "ready") {
      log.info(`Helper connected to ${this.udid.slice(0, 8)}… via ${String(first.transport)} (pymobiledevice3 ${String(first.pmd3)})`);
      proc.onEvent = (m: JsonMessage) => {
        if (m.event !== "lost" || this.proc !== proc) return;
        this.proc = null;
        proc.onExit = null;
        this.retiring = proc.stop(2000);
        this.onLost?.(classifyHelperError(String(m.error ?? ""), "The connection to the device was lost."));
      };
      proc.onExit = (code, _sig, stderr) => {
        if (this.proc !== proc) return;
        this.proc = null;
        this.onLost?.(classifyHelperError(stderr, `The iOS helper stopped unexpectedly (exit ${code ?? "signal"}).`));
      };
      this.proc = proc;
      return null;
    }
    await proc.stop(1000);
    if (signal?.aborted) return { code: "internal", message: "Cancelled." };
    if (!first && !proc.exited)
      return { code: "timeout", message: "The device did not connect within 90 seconds.", detail: proc.stderr.slice(-600) || undefined };
    return classifyHelperError(String(first?.error ?? "") || proc.stderr, "Could not connect to the device.");
  }

  async apply(p: LatLng, signal: AbortSignal): Promise<ApplyResult> {
    const startError = await this.ensure(signal);
    if (startError) return { ok: false, error: startError };
    const res = await this.proc!.request({ cmd: "set", lat: p.lat, lng: p.lng }, 20_000, signal);
    if (res.ok) return { ok: true, confirmation: "holding" };
    if (res.aborted) return { ok: false, error: { code: "internal", message: "Cancelled." } };
    if (res.timeout) return { ok: false, error: { code: "timeout", message: "The device did not confirm the location in time." } };
    return { ok: false, error: classifyHelperError(String(res.error ?? ""), "The device rejected the simulated location.") };
  }

  async clear(): Promise<ApplyResult> {
    const startError = await this.ensure();
    if (startError) return { ok: false, error: startError };
    const res = await this.proc!.request({ cmd: "clear" }, 20_000);
    if (res.ok) return { ok: true, confirmation: "exit-ok" };
    return { ok: false, error: classifyHelperError(String(res.error ?? ""), "Clearing the simulated location failed.") };
  }

  async dispose(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      proc.onEvent = null;
      proc.onExit = null;
      await proc.stop();
    }
    await this.retiring;
  }
}

/** iOS ≤ 16: DTSimulateLocation sets a location that persists until cleared. */
class LegacySession implements LocationSession {
  readonly capabilities = { continuous: true, minIntervalMs: 1500, playback: false, restoresOnClear: true };
  onLost: ((e: SimError) => void) | null = null;

  constructor(
    private readonly tool: Tool,
    private readonly udid: string,
    private readonly settings: Settings,
  ) {}

  private async call(sub: string[], positional: string[], signal?: AbortSignal): Promise<ApplyResult> {
    const args = [...this.tool.prefix, "developer", "simulate-location", ...sub, ...connectionArgs(this.settings, this.udid), "--", ...positional];
    try {
      const res = await run(this.tool.cmd, args, { timeoutMs: 45_000, signal, quiet: sub[0] === "set" });
      if (res.timedOut) return { ok: false, error: { code: "timeout", message: "The device did not respond in time." } };
      if (res.code === 0) return { ok: true, confirmation: "exit-ok" };
      return { ok: false, error: classifyToolError(res.stderr || res.stdout) };
    } catch (e) {
      return { ok: false, error: { code: "internal", message: (e as Error).message } };
    }
  }

  apply(p: LatLng, signal: AbortSignal) {
    return this.call(["set"], [p.lat.toFixed(7), p.lng.toFixed(7)], signal);
  }

  clear() {
    return this.call(["clear"], []);
  }

  async dispose(): Promise<void> {}
}
