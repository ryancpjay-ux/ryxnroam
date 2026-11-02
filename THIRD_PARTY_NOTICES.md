# Third-party notices

ryxnroam is MIT-licensed. It bundles or uses the following.

## Bundled in the application

| Component | Licence | Use |
| --- | --- | --- |
| [Electron](https://github.com/electron/electron) | MIT | Desktop runtime (includes Chromium and Node.js under their own licences, shipped in `LICENSES.chromium.html`) |
| [React](https://github.com/facebook/react) | MIT | Interface |
| [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) | BSD-3-Clause | Interactive vector map |
| [zustand](https://github.com/pmndrs/zustand) | MIT | Renderer state |
| [Lucide](https://lucide.dev) | ISC | Icons |
| [electron-updater](https://github.com/electron-userland/electron-builder) | MIT | GitHub Releases updates |

## Online services (used at runtime, not bundled)

| Service | Terms honoured |
| --- | --- |
| [OpenFreeMap](https://openfreemap.org) vector tiles, OpenMapTiles schema | Free, keyless; attribution shown on the map |
| OpenStreetMap data | © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright); attribution shown on the map and in search results |
| [Photon](https://photon.komoot.io) (komoot) | Search-as-you-type, debounced (380 ms), cached |
| [Nominatim](https://operations.osmfoundation.org/policies/nominatim/) | Only explicit searches (Enter) and reverse lookups; ≤ 1 request/s; identifying User-Agent; responses cached; never used for autocomplete |
| [FOSSGIS OSRM](https://routing.openstreetmap.de) | Road routing; ≤ 1 request/s; identifying User-Agent; cached; straight-line fallback |
| GitHub Releases | Update checks, only when you click “Check for updates” |

## External tools (installed by the user, invoked as separate programs, not bundled)

| Tool | Licence | Use |
| --- | --- | --- |
| Xcode `simctl` | Apple Xcode licence | iOS Simulator location (`xcrun simctl location`) |
| Android SDK `adb` | Apache-2.0 | Android Emulator location (`adb emu geo fix`) |
| [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) | GPL-3.0 | Physical iPhone/iPad location through Apple's developer services |

ryxnroam communicates with these tools only in separate processes. For iOS 17+ it ships [helpers/ios_location_helper.py](helpers/ios_location_helper.py), a separate program licensed **GPL-3.0-or-later** (full text in [helpers/COPYING](helpers/COPYING)) because it imports pymobiledevice3; ryxnroam starts it with your pymobiledevice3 Python and talks to it over stdin/stdout. pymobiledevice3 itself is not bundled.

## References studied, nothing incorporated

* [LocationSimulator](https://github.com/Schlaubischlump/LocationSimulator) (GPL-3.0) — studied for architecture and workflow (device detection, developer disk image, reset behaviour, movement presets). **No code, assets or text were copied**, so its GPL obligations do not attach to ryxnroam. Note its own README: the published source does not support iOS 17+.
* [GhostMe](https://www.getghostme.com) — public website read as a product/feature reference only. No code, branding, artwork or assets are used.
