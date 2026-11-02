# Test results

Run on 2026-11-01 · macOS 27.0.1 (Apple Silicon) · Node 24.22.1 · Electron 45.2.1.
Build machine had **no Xcode (Command Line Tools only), no Android SDK, no pymobiledevice3 and no physical devices**.

## Labels

* **Real** — exercised the real thing (real app, real map tiles, real network services).
* **Simulated (fake tool)** — adapter code ran real processes, but against fake `xcrun` / `adb` / `pymobiledevice3` scripts that mimic the documented output. Proves command construction, parsing and lifecycle; does **not** prove a device accepted a location.
* **Test adapter** — the in-app loopback adapter; no device involved.

## Static checks

| Check | Result |
| --- | --- |
| `tsc --noEmit` (main, preload, renderer, tests) | ✅ no errors |

## Unit tests — `npm test` (Vitest) — 65 passed, 0 failed (+1 opt-in real-device test)

| Suite | Tests | Kind |
| --- | --- | --- |
| geo, coordinates, GPX | 22 | Real (pure logic) |
| output parsers, error classification, tunnel flags | 5 | Real (pure logic) |
| iOS Simulator adapter | 2 | Simulated (fake `xcrun`) |
| Android Emulator adapter | 1 | Simulated (fake `adb`) |
| iOS device adapter: discovery + Developer Mode, iOS 17+ helper set/update/clear, start-up error, rejection, lost connection, tunnel mode, iOS ≤16 path, disk-image action | 8 | Simulated (fake `pymobiledevice3` + fake helper) |
| Helper discovery: script path, Python from launcher shebang | 2 | Real (pure logic) |
| Simulation controller: confirm-before-active, unknown device, rejection, disconnect, route pause/resume/arrive, live speed change, shutdown restore | 7 | Test adapter |
| JSON store, sanitizers, scheduler (consent, run, missing device, missed, cancel), routing fallback, OSRM + Photon parsing | 13 | Real logic, stubbed HTTP |

## End-to-end — `npm run test:e2e` (Playwright driving the real Electron app) — 15 tests

Ran twice: against `dist/` and against the packaged, ad-hoc-signed `release/mac-arm64/ryxnroam.app` (`ROAM_APP_PATH=…`). Both 14/14.

| Test | Kind |
| --- | --- |
| Intro → 5-step onboarding → completion persisted, not repeated on relaunch | Real |
| Map loads OpenFreeMap vector tiles; OSM attribution visible | Real (network) |
| Missing tooling reported as “not available” with guidance; test adapter hidden by default | Real (this machine) |
| Search “Eiffel Tower Paris” → select result → name + coordinates | Real (network) |
| Typed coordinates; panel says *Preview only*; Start disabled without a device | Real |
| Start → confirm dialog → active only after confirmation → Stop sends `clear` | Test adapter |
| Rejected location shows **Simulation failed**, never success | Test adapter |
| Device disconnect mid-simulation detected and reported | Test adapter |
| Favourite saved and present in `library.json` | Real |
| Route: two stops, straight lines, start, pause (status pill “Route paused”), resume, positions streamed, stop | Test adapter |
| Route saved | Real |
| Schedule with consent runs ~1.5 s later and is recorded **completed** | Test adapter |
| Settings persist across restart; quitting ends the running simulation; no child processes left | Real + test adapter |
| No renderer errors logged | Real |

After every run `pgrep` found no leftover ryxnroam or Electron processes.

Map styles: Dark and Light now include point-of-interest names. A bug where switching to Light left the dark map in place (a duplicate `airport` layer made MapLibre reject the built style silently) is fixed, covered by `tests/unit/mapStyles.test.ts`, and a rejected built style now falls back to the published one.

Bugs the E2E runs caught and that are fixed: previous-query search results stayed clickable (and an in-flight response could restore them) while a new search loaded; moving focus from the latitude to the longitude field committed a half-typed point.

## Packaging

| Artifact | Result |
| --- | --- |
| `ryxnroam-0.1.0-mac-arm64.dmg` / `.zip` | ✅ built, ad-hoc signed (`codesign --verify --deep --strict` passes); the app inside passes all 14 E2E tests |
| `ryxnroam-0.1.0-mac-x64.dmg` / `.zip` | ✅ built, ad-hoc signed; **not run** (Apple Silicon machine) |
| `ryxnroam-0.1.0-win-x64.exe` (NSIS) + `latest.yml` | ✅ cross-built on macOS; **not run** (no Windows machine) |
| `latest-mac.yml`, blockmaps | ✅ generated for the updater |
| Update check from the packaged app | ✅ reports “No published release was found at github.com/ryancpjay-ux/ryxnroam/releases” (repository not created yet) |
| Developer ID signing / notarization / Windows Authenticode | ❌ not performed — no credentials available |

## Real hardware (added later on 2026-11-01)

| Check | Result |
| --- | --- |
| pymobiledevice3 11.49.1 installed; every subcommand and flag the adapter uses exists unchanged (`usbmux list`, `amfi developer-mode-status`, `developer dvt simulate-location set/play/clear`, legacy `developer simulate-location`, `mounter auto-mount`, `--udid`, `--userspace`, `--tunnel`) | ✅ Real |
| ryxnroam detects the tool (path + version) and a USB-connected iPad on iPadOS 27.0.1 | ✅ Real |
| Developer Mode off is reported as **Permission required** with the fix; Start stays disabled | ✅ Real |
| E2E runs ignore real devices (only the loopback adapter can list devices unless `ROAM_E2E_REAL_DEVICES=1`) | ✅ asserted by a test |
| **Bug found on an iPhone 15 Pro (iOS 27.0.1):** the location reverted after ~30 s while ryxnroam still showed it as active. Cause: `simulate-location set` blocks pymobiledevice3's event loop (`signal.sigwait`), which also runs the userspace tunnel, so the device dropped the connection | ✅ Diagnosed from pymobiledevice3 11.49.1 source |
| New helper on the iPhone: userspace tunnel up in 1.0 s, 8 consecutive confirmed commands over 70 s, clean quit, no leftover processes | ✅ Real (clear-only, location never moved) |
| `ROAM_REAL_IOS_UDID=… npx vitest run tests/unit/realDevice.test.ts` — full adapter path (Python from launcher, helper, connect, clear) | ✅ Real (clear-only) |
| **User-confirmed:** a simulated location set from the packaged app holds smoothly on an iPhone 15 Pro and an iPad (both iOS/iPadOS 27.0.1), checked in Find My | ✅ Real |

## Not verified

* Routes and Wi-Fi connections on real hardware; the iOS Simulator and the Android Emulator.
* Windows runtime behaviour (window controls, NSIS install/uninstall, pymobiledevice3 on Windows).
