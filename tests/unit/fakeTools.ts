import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Fake `xcrun`, `adb` and `pymobiledevice3` executables. They mimic the
 * documented output of the real tools so adapter command construction,
 * parsing and state handling can be tested without Xcode, the Android SDK or
 * hardware. Results from these tests are SIMULATED, not device-verified.
 */
export function installFakeTools() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ryxnroam-faketools-"));
  const log = path.join(dir, "calls.log");
  writeFileSync(log, "");
  const script = (name: string, body: string) => {
    const p = path.join(dir, name);
    writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(p, 0o755);
  };

  script(
    "xcrun",
    `
case "$1 $2" in
  "simctl help") exit 0 ;;
  "xcodebuild -version") echo "Xcode 16.4"; echo "Build version 16F6"; exit 0 ;;
  "simctl list") cat <<'JSON'
{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-5":[{"udid":"SIM-UDID-1","name":"iPhone 16 Pro","state":"Booted","isAvailable":true}],"com.apple.CoreSimulator.SimRuntime.watchOS-11-0":[{"udid":"SIM-UDID-2","name":"Apple Watch","state":"Shutdown","isAvailable":true}]}}
JSON
  exit 0 ;;
  "simctl location")
    if [ -n "$FAKE_FAIL" ]; then echo "Invalid device: $3" >&2; exit 1; fi
    exit 0 ;;
esac
exit 2`,
  );

  script(
    "adb",
    `
if [ "$1" = "version" ]; then echo "Android Debug Bridge version 1.0.41"; exit 0; fi
if [ "$1" = "devices" ]; then
  echo "List of devices attached"
  echo "emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1"
  echo "R58M123ABC             device usb:1-1 product:beyond1 model:SM_G973F device:beyond1 transport_id:2"
  echo "emulator-5556          unauthorized transport_id:3"
  exit 0
fi
if [ "$3 $4 $5" = "emu avd name" ]; then echo "Pixel_8_API_35"; echo "OK"; exit 0; fi
if [ "$3 $4 $5" = "emu geo fix" ]; then echo "OK"; exit 0; fi
exit 2`,
  );

  script(
    "pymobiledevice3",
    `
case "$1" in
  version) echo "5.1.2"; exit 0 ;;
  usbmux) cat <<'JSON'
[{"BuildVersion":"22A3354","ConnectionType":"USB","DeviceClass":"iPhone","DeviceName":"Test iPhone","Identifier":"00008110-AAA","ProductType":"iPhone15,2","ProductVersion":"18.1","UniqueDeviceID":"00008110-AAA"},
 {"ConnectionType":"Network","DeviceClass":"iPad","DeviceName":"Old iPad","ProductType":"iPad8,1","ProductVersion":"16.7","UniqueDeviceID":"LEGACY-BBB"},
 {"ConnectionType":"USB","DeviceClass":"iPhone","DeviceName":"Locked Down","ProductType":"iPhone14,5","ProductVersion":"17.4","UniqueDeviceID":"DEVMODE-OFF"},
 {"ConnectionType":"Network","DeviceClass":"iPhone","DeviceName":"Locked Down","ProductType":"iPhone14,5","ProductVersion":"17.4","UniqueDeviceID":"DEVMODE-OFF"}]
JSON
  exit 0 ;;
  amfi)
    case "$*" in *DEVMODE-OFF*) echo "false" ;; *) echo "true" ;; esac
    exit 0 ;;
  mounter) echo "DeveloperDiskImage already mounted"; exit 1 ;;
  lockdown)
    state="${dir}/wifi.state"
    for last; do :; done
    case "$last" in on) echo true > "$state"; exit 0 ;; off) echo false > "$state"; exit 0 ;; esac
    printf '{\n    "EnableWifiConnections": %s\n}\n' "$(cat "$state" 2>/dev/null || echo false)"; exit 0 ;;
  developer)
    if [ "$2" = "dvt" ]; then
      case "$4" in
        set)
          if [ -n "$FAKE_FAIL" ]; then echo "pymobiledevice3.exceptions.DeveloperModeIsNotEnabledError: developer mode is not enabled" >&2; exit 1; fi
          trap 'echo "pymobiledevice3 held-exit" >> "${log}"; exit 0' INT TERM
          echo "Press Ctrl+C to send a SIGINT or use 'kill' command to send a SIGTERM"
          while true; do sleep 0.05; done ;;
        play)
          trap 'echo "pymobiledevice3 play-exit" >> "${log}"; exit 0' INT TERM
          while true; do sleep 0.05; done ;;
        clear) exit 0 ;;
      esac
    fi
    if [ "$2" = "simulate-location" ]; then exit 0; fi
    exit 2 ;;
esac
exit 2`,
  );

  const original = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${original}`;
  return {
    dir,
    calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    reset: () => writeFileSync(log, ""),
    restore: () => {
      process.env.PATH = original;
    },
  };
}
