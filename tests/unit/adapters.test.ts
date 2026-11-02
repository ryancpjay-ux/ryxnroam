/**
 * Adapter tests against FAKE command-line tools (see fakeTools.ts).
 * They verify command construction, output parsing and state reporting.
 * They do not — and cannot — prove a real device accepted a location.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/shared/defaults";
import type { Settings } from "../../src/shared/types";
import { classifyToolError } from "../../src/main/devices/adapter";
import { AndroidEmulatorAdapter, parseAdbDevices } from "../../src/main/devices/androidEmulator";
import { IosDeviceAdapter, connectionArgs, helperScriptPath, parseLockdownInfo, parseUdidList, pythonFromLauncher } from "../../src/main/devices/iosDevice";
import { IosSimulatorAdapter, parseSimctlDevices } from "../../src/main/devices/iosSimulator";
import { liveChildCount } from "../../src/main/exec";
import { installFakeTools } from "./fakeTools";

const settings = (): Settings => structuredClone(DEFAULT_SETTINGS);
// The fake tools are POSIX shell scripts, which Windows can't execute; those suites run on macOS/Linux CI.
const posix = process.platform !== "win32";
const signal = () => new AbortController().signal;
let fake: ReturnType<typeof installFakeTools>;

beforeAll(() => {
  fake = installFakeTools();
});
afterAll(() => fake.restore());
beforeEach(() => {
  fake.reset();
  delete process.env.FAKE_FAIL;
});

describe("output parsers", () => {
  it("parses booted simulators only", () => {
    const list = parseSimctlDevices(
      JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-17-2": [
            { udid: "A", name: "iPhone 15", state: "Booted", isAvailable: true },
            { udid: "B", name: "iPhone SE", state: "Shutdown", isAvailable: true },
          ],
        },
      }),
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "ios-simulator:A", osName: "iOS", osVersion: "17.2", state: "connected" });
  });

  it("classifies adb devices honestly", () => {
    const list = parseAdbDevices(
      "List of devices attached\nemulator-5554 device model:sdk\nR58 device model:SM_G973F\nemulator-5556 unauthorized\nemulator-5558 offline\n",
    );
    expect(list.map((d) => d.state)).toEqual(["connected", "unsupported", "permission-required", "disconnected"]);
    expect(list[0].restoresOnStop).toBe(false);
    expect(list[1].guidance).toMatch(/mock location app/);
  });

  it("parses usbmux UDID lists and lockdown info even with leading noise", () => {
    expect(parseUdidList('warning: something\n[\n  "AAA",\n  "BBB"\n]')).toEqual(["AAA", "BBB"]);
    expect(parseUdidList("no json")).toEqual([]);
    expect(parseLockdownInfo('note\n{"DeviceName":"X","ProductVersion":"18.1"}')).toEqual({ DeviceName: "X", ProductVersion: "18.1" });
    expect(parseLockdownInfo("no json")).toBeNull();
  });

  it("maps tool errors to actionable categories", () => {
    expect(classifyToolError("DeveloperModeIsNotEnabledError: developer mode is not enabled").code).toBe("permission-required");
    expect(classifyToolError("PairingDialogResponsePending").code).toBe("permission-required");
    expect(classifyToolError("InvalidServiceError: DeveloperDiskImage").code).toBe("ddi-required");
    expect(classifyToolError("ConnectionFailedToUsbmuxdError device disconnected").code).toBe("device-disconnected");
    expect(classifyToolError("something odd").code).toBe("rejected");
  });

  it("builds pymobiledevice3 connection flags per tunnel mode", () => {
    const s = settings();
    expect(connectionArgs(s, "U")).toEqual(["--udid", "U"]);
    s.devices.iosTunnel = "userspace";
    expect(connectionArgs(s, "U")).toEqual(["--userspace", "--udid", "U"]);
    s.devices.iosTunnel = "tunneld";
    expect(connectionArgs(s, "U")).toEqual(["--tunnel", "U"]);
  });
});

describe.skipIf(process.platform !== "darwin")("iOS Simulator adapter (fake xcrun)", () => {
  const adapter = new IosSimulatorAdapter();

  it("probes, discovers and sets/clears location with simctl", async () => {
    const status = await adapter.probe(settings(), signal());
    expect(status).toMatchObject({ available: true, toolVersion: "Xcode 16.4" });
    const [device] = await adapter.discover(settings(), signal());
    expect(device).toMatchObject({ name: "iPhone 16 Pro", nativeId: "SIM-UDID-1", osVersion: "18.5" });
    const session = adapter.openSession(device);
    expect(await session.apply({ lat: 1.5, lng: -2.25 }, signal())).toEqual({ ok: true, confirmation: "exit-ok" });
    expect(await session.clear()).toEqual({ ok: true, confirmation: "exit-ok" });
    expect(fake.calls()).toContain("xcrun simctl location SIM-UDID-1 set 1.5000000,-2.2500000");
    expect(fake.calls()).toContain("xcrun simctl location SIM-UDID-1 clear");
  });

  it("reports rejection instead of success", async () => {
    const [device] = await adapter.discover(settings(), signal());
    process.env.FAKE_FAIL = "1";
    const res = await adapter.openSession(device).apply({ lat: 0, lng: 0 }, signal());
    expect(res.ok).toBe(false);
  });
});

describe.skipIf(!posix)("Android emulator adapter (fake adb)", () => {
  const adapter = new AndroidEmulatorAdapter();

  it("names emulators, refuses physical devices and sends geo fix as lng lat", async () => {
    expect((await adapter.probe(settings(), signal())).available).toBe(true);
    const devices = await adapter.discover(settings(), signal());
    const emu = devices.find((d) => d.nativeId === "emulator-5554")!;
    expect(emu.name).toBe("Pixel 8 API 35");
    expect(devices.find((d) => d.nativeId === "R58M123ABC")?.state).toBe("unsupported");
    expect(devices.find((d) => d.nativeId === "emulator-5556")?.state).toBe("permission-required");
    const res = await adapter.openSession(emu, settings()).apply({ lat: 10, lng: 20 }, signal());
    expect(res.ok).toBe(true);
    expect(fake.calls()).toContain("adb -s emulator-5554 emu geo fix 20.0000000 10.0000000");
  });
});

describe.skipIf(!posix)("iOS device adapter (fake pymobiledevice3 + fake helper)", () => {
  const adapter = new IosDeviceAdapter();
  const helperLog = path.join(mkdtempSync(path.join(os.tmpdir(), "ryxnroam-helper-")), "helper.log");
  const fakeHelper = fileURLToPath(new URL("./fakeHelper.mjs", import.meta.url));
  adapter.helperCommand = (udid, mode) => ({ cmd: process.execPath, args: [fakeHelper, "--udid", udid, "--mode", mode] });
  const helperCalls = () => (existsSync(helperLog) ? readFileSync(helperLog, "utf8").trim().split("\n") : []);
  beforeEach(() => {
    writeFileSync(helperLog, "");
    process.env.FAKE_HELPER_LOG = helperLog;
    delete process.env.FAKE_HELPER_MODE;
  });

  it("discovers devices and reports Developer Mode honestly", async () => {
    const status = await adapter.probe(settings(), signal());
    expect(status).toMatchObject({ available: true, toolVersion: "5.1.2" });
    const devices = await adapter.discover(settings(), signal());
    expect(devices.map((d) => [d.name, d.state])).toEqual([
      ["Test iPhone", "connected"],
      ["Locked Down", "permission-required"],
      ["Old iPad", "connected"],
    ]);
    expect(devices[2]).toMatchObject({ connection: "network", osName: "iPadOS", wifi: "on" });
  });

  it("lists devices without a lockdown session per device per scan; reads each device's details once", async () => {
    const fresh = new IosDeviceAdapter();
    await fresh.probe(settings(), signal());
    fake.reset();
    const first = await fresh.discover(settings(), signal());
    await fresh.discover(settings(), signal());
    expect(first.map((d) => [d.name, d.connection, d.osVersion])).toEqual([
      ["Test iPhone", "usb", "18.1"],
      ["Locked Down", "usb", "17.4"],
      ["Old iPad", "network", "16.7"],
    ]);
    const calls = fake.calls();
    // The full `usbmux list` opens lockdown to every device; scans use the lockdown-free listing.
    expect(calls).not.toContain("pymobiledevice3 usbmux list");
    expect(calls.filter((c) => c === "pymobiledevice3 usbmux list --simple -n")).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith("pymobiledevice3 lockdown info"))).toHaveLength(3);
  });

  it("lists devices without waiting on a slow Developer Mode check, then reports it on the next scan", async () => {
    const fresh = new IosDeviceAdapter();
    await fresh.probe(settings(), signal());
    process.env.FAKE_AMFI_DELAY = "4";
    try {
      const t0 = Date.now();
      const first = await fresh.discover(settings(), signal());
      expect(Date.now() - t0).toBeLessThan(3500);
      expect(first.map((d) => d.name)).toEqual(["Test iPhone", "Locked Down", "Old iPad"]);
      // Status not known yet: the device is listed as connected, not guessed to be blocked.
      expect(first.find((d) => d.name === "Locked Down")!.state).toBe("connected");
      // One check per device, even if scans overlap while it runs.
      await fresh.discover(settings(), signal());
      await new Promise((r) => setTimeout(r, 3000));
      const amfiCalls = fake.calls().filter((c) => c.startsWith("pymobiledevice3 amfi"));
      expect(amfiCalls).toHaveLength(3);
      const second = await fresh.discover(settings(), signal());
      expect(second.find((d) => d.name === "Locked Down")!.state).toBe("permission-required");
    } finally {
      delete process.env.FAKE_AMFI_DELAY;
    }
  }, 20_000);

  it("offers Wi-Fi access for a cabled device, sets it, and keeps the USB entry when listed twice", async () => {
    const before = await adapter.discover(settings(), signal());
    const phone = before.find((d) => d.name === "Test iPhone")!;
    expect(phone).toMatchObject({ connection: "usb", wifi: "off" });
    expect(phone.actions?.map((a) => a.id)).toContain("enable-wifi");
    // Listed on both USB and Wi-Fi: one device, on the cable, already Wi-Fi ready.
    expect(before.filter((d) => d.name === "Locked Down")).toHaveLength(1);
    expect(before.find((d) => d.name === "Locked Down")).toMatchObject({ connection: "usb", wifi: "on" });

    await expect(adapter.runAction(phone, "enable-wifi", settings())).resolves.toMatch(/can now be used over Wi-Fi/);
    expect(fake.calls()).toContain("pymobiledevice3 lockdown wifi-connections --udid 00008110-AAA on");
    const after = (await adapter.discover(settings(), signal())).find((d) => d.name === "Test iPhone")!;
    expect(after.wifi).toBe("on");
    expect(after.actions?.map((a) => a.id)).toContain("disable-wifi");
    await adapter.runAction(after, "disable-wifi", settings());

    const ipad = before.find((d) => d.name === "Old iPad")!;
    await expect(adapter.runAction(ipad, "enable-wifi", settings())).rejects.toThrow(/with a cable/);
  });

  it("iOS 17+: one helper holds the location, accepts updates and clears on stop", async () => {
    const [device] = await adapter.discover(settings(), signal());
    const session = adapter.openSession(device, settings());
    expect(session.capabilities).toMatchObject({ continuous: true, playback: false });
    expect(await session.apply({ lat: 40.689247, lng: -74.044502 }, signal())).toEqual({ ok: true, confirmation: "holding" });
    expect(await session.apply({ lat: 40.7, lng: -74.05 }, signal())).toEqual({ ok: true, confirmation: "holding" });
    expect(liveChildCount()).toBe(1);
    expect((await session.clear()).ok).toBe(true);
    await session.dispose();
    expect(liveChildCount()).toBe(0);
    expect(helperCalls()).toEqual([
      "start --udid 00008110-AAA --mode auto",
      "set 40.689247 -74.044502",
      "set 40.7 -74.05",
      "clear",
      "quit",
    ]);
  });

  it("iOS 17+: surfaces start-up errors instead of claiming success", async () => {
    const [device] = await adapter.discover(settings(), signal());
    process.env.FAKE_HELPER_MODE = "fatal";
    const res = await adapter.openSession(device, settings()).apply({ lat: 0, lng: 0 }, signal());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("permission-required");
    expect(liveChildCount()).toBe(0);
  });

  it("iOS 17+: reports a rejected location", async () => {
    const [device] = await adapter.discover(settings(), signal());
    process.env.FAKE_HELPER_MODE = "reject";
    const session = adapter.openSession(device, settings());
    const res = await session.apply({ lat: 0, lng: 0 }, signal());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("ddi-required");
    await session.dispose();
  });

  it("iOS 17+: a dropped connection fires onLost", async () => {
    const [device] = await adapter.discover(settings(), signal());
    process.env.FAKE_HELPER_MODE = "lose-after-set";
    const session = adapter.openSession(device, settings());
    const lost = new Promise<string>((resolve) => (session.onLost = (e) => resolve(e.code)));
    expect((await session.apply({ lat: 1, lng: 1 }, signal())).ok).toBe(true);
    expect(await lost).toBe("device-disconnected");
    await session.dispose();
    expect(liveChildCount()).toBe(0);
  });

  it("passes the tunnel setting to the helper", async () => {
    const [device] = await adapter.discover(settings(), signal());
    const s = settings();
    s.devices.iosTunnel = "tunneld";
    const session = adapter.openSession(device, s);
    await session.apply({ lat: 1, lng: 2 }, signal());
    await session.dispose();
    expect(helperCalls()[0]).toBe("start --udid 00008110-AAA --mode tunneld");
  });

  it("iOS ≤ 16 uses the legacy DTSimulateLocation command", async () => {
    const devices = await adapter.discover(settings(), signal());
    const legacy = devices.find((d) => d.osVersion === "16.7")!;
    const session = adapter.openSession(legacy, settings());
    expect(session.capabilities.continuous).toBe(true);
    expect((await session.apply({ lat: 1, lng: 2 }, signal())).ok).toBe(true);
    expect(fake.calls()).toContain("pymobiledevice3 developer simulate-location set --udid LEGACY-BBB -- 1.0000000 2.0000000");
  });

  it("treats an already-mounted disk image as success", async () => {
    const [device] = await adapter.discover(settings(), signal());
    await expect(adapter.runAction(device, "mount-ddi", settings())).resolves.toMatch(/already mounted/);
  });
});

describe("helper discovery", () => {
  it("finds the helper script in the checkout", () => {
    expect(helperScriptPath()).toMatch(/helpers[\\/]ios_location_helper\.py$/);
  });

  it("reads the Python interpreter from a launcher's shebang", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ryxnroam-shebang-"));
    const direct = path.join(dir, "direct");
    writeFileSync(direct, `#!${process.execPath}\nimport x\n`);
    expect(pythonFromLauncher(direct)).toBe(process.execPath);
    if (posix) {
      const viaEnv = path.join(dir, "env");
      writeFileSync(viaEnv, "#!/usr/bin/env sh\n");
      expect(pythonFromLauncher(viaEnv)).toMatch(/\/sh$/);
    }
    expect(pythonFromLauncher(path.join(dir, "missing"))).toBeNull();
  });
});
