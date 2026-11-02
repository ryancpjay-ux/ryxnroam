# ryxnroam

**Location simulation studio** — pick a place on a live map, preview it, then apply it to a simulator or a test device you are authorized to control. Move along multi-stop routes at walking, cycling, driving or custom speeds, save favourites and routes, schedule runs, and stop to restore the device's real location.

ryxnroam is a separate application from ryxnontop, built with ryxnontop's design system: the monochrome “mist” palette (pure black/white ink, hairline `#ffffff33` borders, inverse highlights), 24 px window radius, 20 px panels, 15 px top bar, the inverse “r” emblem, the letter-reveal intro and the same spring easing (`cubic-bezier(.16,1,.3,1)`).

> Use ryxnroam only on devices and test environments you own or are authorized to test. It does not bypass device security, managed-device restrictions, parental controls or location-sharing safeguards, and it never runs a simulation without showing it.

---

## Contents

1. [Install & build](#install--build)
2. [Compatibility](#compatibility)
3. [Using ryxnroam](#using-ryxnroam)
4. [Feature checklist](#feature-checklist)
5. [Architecture](#architecture)
6. [Testing](#testing)
7. [Packaging & releases](#packaging--releases)
8. [Privacy & security](#privacy--security)
9. [Known limitations](#known-limitations)
10. [Licensing](#licensing)

---

## Install & build

Requirements: Node.js 22+ and npm. macOS 12+ (Apple Silicon or Intel) or Windows 10/11 x64.

```bash
npm install
```

Electron's binary is fetched by its install script. If your npm blocks install scripts, fetch it once with:

```bash
node node_modules/electron/install.js
```

| Task | Command |
| --- | --- |
| Run in development (Vite + Electron, live reload) | `npm run dev` |
| Build and start | `npm start` |
| Typecheck | `npm run typecheck` |
| Unit tests | `npm test` |
| End-to-end tests (builds first; needs internet) | `npm run test:e2e` |
| macOS DMG + ZIP (arm64 + x64), signed with your Developer ID if one is in the keychain | `npm run package:mac` |
| macOS DMG + ZIP, ad-hoc signed (no Apple account needed) | `npm run package:mac:unsigned` |
| Windows x64 NSIS installer | `npm run package:win` |
| Unpacked app for the current platform | `npm run package:dir` |

Output goes to `release/`. Ad-hoc signed builds run on the machine that built them; on another Mac, Gatekeeper blocks them until you right-click › Open (or remove the quarantine flag), because they are not notarized. An unpacked `package:dir` build can be ad-hoc signed by hand:

```bash
codesign --force --deep --sign - release/mac-arm64/ryxnroam.app
```

### Device tooling (install only what you need)

| To drive | Install |
| --- | --- |
| iOS Simulator | Xcode 14 or later, opened once. If only Command Line Tools are selected: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` |
| iPhone / iPad | `python3 -m pip install -U pymobiledevice3`, Developer Mode on (iOS 16+), device trusts this computer. Windows also needs Apple Mobile Device Support (iTunes / Apple Devices). |
| Android Emulator | Android Studio or standalone SDK platform-tools (`adb`) |

ryxnroam finds these on your login-shell `PATH`, `ANDROID_HOME`/`ANDROID_SDK_ROOT`, or the standard SDK locations. Custom paths can be set in **Settings › Devices**.

> **Why a helper for iOS 17+?** `pymobiledevice3 developer dvt simulate-location set` “holds” the location by blocking its own event loop. With the default no-root userspace tunnel, that loop also runs the tunnel, so the device drops the connection — and the simulated location — after about 30 s while the process still looks alive. ryxnroam's helper keeps the loop running, re-confirms the location every 4 s and reports a lost connection instead.

## Compatibility

| Target | macOS | Windows | Mechanism | Stop restores real location | Verified in this build |
| --- | --- | --- | --- | --- | --- |
| iOS Simulator | ✅ | — (Apple only ships it for macOS) | `xcrun simctl location <udid> set/clear` (Apple-documented, Xcode 14+) | Yes (`clear`) | Against a fake `xcrun` (no Xcode on the build machine) |
| iPhone/iPad, iOS 17+ | ✅ | ✅* | ryxnroam's helper ([helpers/ios_location_helper.py](helpers/ios_location_helper.py)) uses pymobiledevice3's library to hold one DVT location channel over the iOS 17+ tunnel, re-confirming it every 4 s. | Yes (`clear`, and automatically if ryxnroam exits) | Connection + clear on an iPhone 15 Pro, iOS 27.0.1; set/route/lost paths against a fake helper |
| iPhone/iPad, iOS ≤ 16 | ✅ | ✅* | `pymobiledevice3 developer simulate-location set/clear` (DTSimulateLocation) | Yes (`clear`) | Against a fake `pymobiledevice3` |
| Android Emulator | ✅ | ✅ | `adb -s <serial> emu geo fix <lng> <lat>` (documented emulator console) | Emulators have no real GPS; the last fix remains and the app says so | Against a fake `adb` |
| Physical Android | ❌ | ❌ | Android only accepts mock locations from an app the user selects in Developer options. ryxnroam does not install one, so these devices are listed as **Unsupported** with that explanation. | — | — |
| Loopback test adapter | ✅ | ✅ | In-process, opt-in (Settings › Devices), labelled TEST everywhere. Changes no real device. | — | Fully, unit + E2E |

\* Windows support for iOS 17.0–17.3.1 needs extra tunnel drivers that pymobiledevice3 does not supply; iOS 17.4+ works through its lockdown tunnel.

Every device is shown with one of: **Connected**, **Disconnected**, **Connecting**, **Unsupported**, **Permission required** — plus **Simulation active** / **Simulation failed** for the running simulation.

Why not LocationSimulator's backend? Its published source (libimobiledevice + classic DeveloperDiskImage) does not support iOS 17+, where Apple moved developer services behind a RemoteXPC tunnel and personalized disk images. ryxnroam uses pymobiledevice3, which implements the current protocol, as an external tool.

## Using ryxnroam

1. **Connect** — boot a simulator, start an emulator, or plug in a device. It appears in the device selector (top-left); the status pill in the top bar always shows its state.
2. **Choose** — click the map, drag the pin, search (⌘K / Ctrl+K), paste coordinates in any common format (`40.6892, -74.0445`, `40°41′21″N 74°02′40″W`), or right-click for more.
3. **Preview** — the pin and map move; nothing is sent. The panel says *Preview only* until you start.
4. **Start simulation** — confirms (optional), then waits for the device tool. The state turns active only after the tool confirms. While active, the top bar turns white and a banner with a **Stop** button sits on the map.
5. **Routes** — switch to Route, click to add stops (A → B, waypoints in between), drag to adjust, choose Walk 5 km/h, Cycle 16 km/h, Drive 50 km/h or Custom 1–300 km/h, follow roads or straight lines, optionally loop. Start, pause, resume, change speed live, stop. Progress shows distance travelled, remaining time and arrival time.
6. **Save & schedule** — star locations (with groups and notes), save routes, export routes as GPX, schedule either to start at a set time with an optional duration.
7. **Stop** — the banner, the panel, ⌘. / Ctrl+. or closing the app. Closing always stops the simulation.

## Feature checklist

| Area | Status |
| --- | --- |
| Map-centric main window, custom title bar, status pill, window controls | ✅ |
| Sidebar: device selector, search, current simulation, saved, routes, schedules, history, settings; collapsible to an icon rail | ✅ |
| MapLibre vector map (OpenFreeMap), smooth zoom/pan, click-to-select, draggable pin, right-click menu | ✅ |
| Map styles: Auto, Dark, Light, Streets, Bright — all with place, road and point-of-interest names; place-name language | ✅ |
| Search (Photon suggestions, Nominatim on Enter), reverse geocoding, coordinate entry (decimal & DMS) | ✅ |
| Saved-location markers, route line with travelled/remaining split, numbered stop markers, animated device marker | ✅ |
| Floating control panel: destination, lat/lng fields, preview, start/stop, route controls | ✅ |
| Device discovery (simctl, pymobiledevice3, adb), polling with back-off, disconnect detection | ✅ (fake-tool verified) |
| Explicit device preparation: mount developer disk image, re-check pairing/Developer Mode | ✅ (fake-tool verified) |
| Location simulation controller with confirmation kinds (`exit-ok`, `holding`, `playback`, `test`) | ✅ |
| Route engine: interpolation along great circles, speed presets/custom, live speed change, pause/resume, loop, ETA | ✅ |
| Road routing (OSRM) with honest straight-line fallback | ✅ |
| Favourites: save, name, group, note, edit, delete, filter, sort, preview | ✅ |
| Saved routes: save, load, delete, export GPX | ✅ |
| Scheduling with consent, review step, cancel, outcomes (completed / failed / missed / cancelled), notifications | ✅ |
| History (local), clear history | ✅ |
| Settings: General, Devices, Location, Data, About | ✅ |
| Export / import (JSON, merge without overwrite) | ✅ |
| Onboarding (5 steps, skippable, remembered, re-openable) | ✅ |
| Intro animation (optional), toasts, confirmation dialogs, skeletons, reduced-motion support | ✅ |
| Keep computer awake during simulation (optional) | ✅ |
| GitHub Releases updater (draft → publish = approval) | ✅ (checked against the not-yet-created repo) |
| Light theme | ✅ |
| Interface translations | ❌ English only (place names can be localized) |

## Architecture

```
src/
  shared/           types, geo math (great-circle interpolation, Polyline), coordinate parsing,
                    GPX builder, IPC contract (RoamApi), defaults — used by both processes
  main/             Electron main process (no UI code)
    index.ts        lifecycle, window, menu, power-save blocker, quit → stop & restore
    ipc.ts          validated IPC handlers (every payload re-checked by sanitize.ts)
    store.ts        atomic JSON stores (temp file + rename, corrupt files kept aside)
    exec.ts         shell-free process runner, held processes, orphan-proof child tracking
    devices/        adapter.ts (the engine ↔ platform contract), manager.ts (discovery),
                    iosSimulator.ts, iosDevice.ts, androidEmulator.ts, testAdapter.ts
    simulation/     controller.ts — the single active simulation, serialized transitions
    services/       geocoding.ts, routing.ts, http.ts (rate gates, TTL caches, UA)
    scheduler.ts    timers, missed/failed/completed outcomes
    history.ts, updates.ts, log.ts (in-memory diagnostics ring buffer)
  preload/          contextBridge → window.roam (typed RoamApi), nothing else exposed
  renderer/         React 19 + zustand; components/, styles/ (tokens.css = ryxnontop tokens)
```

**Adapter contract** (`src/main/devices/adapter.ts`): `probe` (tooling), `discover` (devices), `openSession(device)` → `LocationSession { capabilities, apply, play?, clear, dispose, onLost }`. An adapter may only resolve `apply` after its tool confirmed the change, and reports *how* it knows (`confirmation`). The controller never marks a simulation active without that result, and the UI words its status accordingly (e.g. GPX playback is shown as an estimate, not a confirmation).

Security: `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP (scripts from the app only; network only to the tile host), navigation blocked, external links only `https:` via the system browser, all permission requests denied, child processes spawned without a shell with argument arrays.

## Testing

```bash
npm run typecheck && npm test && npm run test:e2e
```

* **Unit (Vitest, 65 tests)** — geo math, coordinate parsing/formatting, GPX timing, simulator/emulator/device output parsers, error classification, all three platform adapters driven against **fake `xcrun` / `adb` / `pymobiledevice3` executables and a fake iOS helper** (command lines, set/update/clear lifecycle, start-up errors, rejections, lost connections, no leftover processes), the simulation controller (confirm-before-active, rejection, disconnect, route progress/pause/resume/speed change/completion, shutdown restore), scheduler (consent, run, missing device, missed while closed, cancel), atomic store, sanitizers, routing fallback and geocoder mapping with stubbed HTTP.
* **End-to-end (Playwright + Electron, 15 tests)** — real app, isolated profile: intro → onboarding persistence, real vector tiles + attribution, honest “not available” reporting, live search, coordinate entry and *Preview only* state, simulation start/confirm/stop on the test adapter, rejection shown as failure, disconnect mid-simulation, favourite persistence, route build/run/pause/resume/stop, route save, a consented schedule running to completion, settings persistence across restart, quitting ends the simulation, no child processes, no renderer errors. Set `ROAM_APP_PATH` to run the same suite against a packaged app. E2E runs only ever list the loopback test device, even with real phones or simulators attached (opt in with `ROAM_E2E_REAL_DEVICES=1`).
* CI runs typecheck and unit tests on macOS and Windows; the fake-tool adapter suites are POSIX shell scripts, so they run on macOS only.
* `node tests/e2e/shot.mjs <dir>` saves screenshots of the main states for a visual check.

Results from the last run are in [docs/TEST_RESULTS.md](docs/TEST_RESULTS.md).

## Packaging & releases

Configuration: [electron-builder.yml](electron-builder.yml), [build/entitlements.mac.plist](build/entitlements.mac.plist) (only `allow-jit`), workflows in [.github/workflows](.github/workflows).

* **macOS**: DMG + ZIP for arm64 and x64, hardened runtime, minimum macOS 12. Appears in the Dock and in screen recordings like any normal app.
* **Windows**: x64 NSIS installer, per-user, choosable directory, Start-menu and desktop shortcuts, standard uninstaller in *Apps & features* (saved data in `%APPDATA%\ryxnroam` is kept; delete that folder to remove it).
* **Releases**: push a `v*` tag to the **ryxnroam** repository (`github.com/ryancpjay-ux/ryxnroam`, to be created — nothing is published to ryxnontop's repository). The workflow tests, builds and uploads to a **draft** release. Publishing the draft is the approval step; only then do installed apps see it.
* **Signing/notarization**: happens only when the repository secrets `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` (and `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` for Windows) exist. Without them the workflow says so and produces unsigned builds. **No build produced so far has been signed with a Developer ID or notarized.**

## Privacy & security

* No account, no telemetry, no analytics. Favourites, routes, schedules, history and settings are JSON files in the app's data folder (shown in Settings › Data).
* Network requests: map tiles (OpenFreeMap), search (Photon / Nominatim), routing (OSRM), and GitHub only when you check for updates.
* A simulation is always visible (inverted top-bar pill, map banner, sidebar card, marker) and always stoppable (banner, panel, menu, ⌘./Ctrl+., closing the window).
* Schedules require an explicit authorization checkbox and a review step; outcomes are recorded truthfully (missed if the app was closed, failed if the device was absent or rejected the command).
* The diagnostic report redacts coordinates before copying.

## Known limitations

* **Verified on real hardware for single locations:** a location set from ryxnroam holds smoothly on an iPhone 15 Pro and an iPad (iOS/iPadOS 27.0.1, pymobiledevice3 11.49.1). Routes and Wi-Fi connections on real hardware, and the iOS Simulator and Android Emulator paths, are verified only against fake executables.
* iOS 17+ needs ryxnroam open and the device connected for the whole simulation; closing ryxnroam, unplugging or locking the connection ends it (ryxnroam reports this).
* The iOS helper depends on pymobiledevice3's Python API (`UserspaceRsdTunnel`, `DvtProvider`, `LocationSimulation`). A future pymobiledevice3 release that changes them would show a clear “couldn't use this pymobiledevice3 install” error.
* iOS 17+ tunnels may require elevated privileges on some setups (e.g. `tunneld` mode); ryxnroam reports this rather than escalating itself.
* iPhone/iPad: iOS's automatic time zone follows location, so simulating another country can move the device's clock to that time zone and leave it there after you stop. ryxnroam reminds you on stop; turn **Settings › General › Date & Time › Set Automatically** off and on to fix it.
* Physical Android devices are not supported (needs an on-device mock-location app).
* Android emulators keep their last fix after stop (they have no real GPS).
* Schedules run only while ryxnroam is open; missed schedules are recorded as missed. Very long runs depend on the computer not sleeping (enable *Keep this computer awake*).
* Public OSM services have fair-use limits; heavy use should switch to self-hosted or commercial endpoints.
* Auto-update installation on macOS requires a signed build; unsigned builds can check for updates but must be updated manually.
* Interface is English only.

## Licensing

ryxnroam is [MIT-licensed](LICENSE). Third-party components, services and external tools are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No code from LocationSimulator (GPL-3.0) or GhostMe is included; pymobiledevice3 (GPL-3.0) is an optional, separately installed program invoked over its CLI.
