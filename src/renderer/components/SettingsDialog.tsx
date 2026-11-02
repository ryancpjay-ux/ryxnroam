import { Copy, Database, Download, Info, MapPin, RefreshCw, Smartphone, SlidersHorizontal, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { PLACE_LANGUAGES } from "../../shared/defaults";
import { formatSpeed, MAX_SPEED_KMH, MIN_SPEED_KMH } from "../../shared/geo";
import type { LogLine, Settings } from "../../shared/types";
import { api } from "../api";
import { chooseDevice, confirmAction, toast, updateSettings, useStore, type SettingsTab } from "../store";
import { deviceSubtitle, STATE_TEXT } from "./DeviceSelector";
import { BrandEmblem, Modal, SelectMenu, StatusDot, Switch, useModalClose } from "./primitives";

const TABS: { id: SettingsTab; label: string; icon: typeof Info }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "devices", label: "Devices", icon: Smartphone },
  { id: "location", label: "Location", icon: MapPin },
  { id: "data", label: "Data", icon: Database },
  { id: "about", label: "About", icon: Info },
];

export function SettingsDialog() {
  const tab = useStore((s) => s.settingsOpen);
  if (!tab) return null;
  return (
    <Modal onClose={() => useStore.setState({ settingsOpen: null })} className="settings" label="Settings">
      <SettingsBody tab={tab} />
    </Modal>
  );
}

function Option({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="option">
      <span>
        <strong>{title}</strong>
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </div>
  );
}

function SettingsBody({ tab }: { tab: SettingsTab }) {
  const close = useModalClose();
  return (
    <>
      <div className="settings-heading">
        <h1>Settings</h1>
        <p>Preferences are stored locally on this computer.</p>
      </div>
      <div className="settings-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} data-testid={`settings-tab-${t.id}`} onClick={() => useStore.setState({ settingsOpen: t.id })}>
            <t.icon /> {t.label}
          </button>
        ))}
      </div>
      <div className="settings-content" key={tab} role="tabpanel">
        {tab === "general" && <GeneralTab />}
        {tab === "devices" && <DevicesTab />}
        {tab === "location" && <LocationTab />}
        {tab === "data" && <DataTab />}
        {tab === "about" && <AboutTab />}
      </div>
      <div className="settings-footer">
        <span>Changes save automatically.</span>
        <button className="primary" onClick={close} data-testid="settings-done">
          Done
        </button>
      </div>
    </>
  );
}

function GeneralTab() {
  const s = useStore((x) => x.settings);
  const info = useStore((x) => x.info);
  return (
    <>
      <div className="card">
        <h2>Appearance</h2>
        <div className="fields">
          <div className="label">
            Theme
            <SelectMenu<Settings["general"]["theme"]>
              label="Theme"
              value={s.general.theme}
              options={[
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
                { value: "system", label: "Match system" },
              ]}
              onChange={(v) => updateSettings({ general: { theme: v } })}
            />
          </div>
          <div className="label">
            Default map style
            <SelectMenu<Settings["general"]["defaultMapStyle"]>
              label="Default map style"
              value={s.general.defaultMapStyle}
              options={[
                { value: "auto", label: "Auto (follows theme)" },
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
                { value: "streets", label: "Streets" },
                { value: "bright", label: "Bright" },
              ]}
              onChange={(v) => {
                useStore.setState({ mapStyleOverride: null });
                void updateSettings({ general: { defaultMapStyle: v } });
              }}
            />
          </div>
          <div className="label wide">
            Place-name language
            <SelectMenu label="Place-name language" value={s.general.placeLanguage} options={PLACE_LANGUAGES.map((l) => ({ value: l.id, label: l.label }))} onChange={(v) => updateSettings({ general: { placeLanguage: v } })} />
            <small className="muted">Used for map labels and search results where OpenStreetMap has a translation. The interface itself is in English.</small>
          </div>
        </div>
      </div>
      <div className="card">
        <h2>Behaviour</h2>
        <Option title="Launch at startup" hint={info?.packaged ? "Open ryxnroam when you sign in." : "Available in installed builds — this is a development build."}>
          <Switch label="Launch at startup" checked={s.general.launchAtStartup} disabled={!info?.packaged} onChange={(v) => updateSettings({ general: { launchAtStartup: v } })} />
        </Option>
        <Option title="Notifications" hint="System notifications for schedule results and simulations that stop unexpectedly.">
          <Switch label="Notifications" checked={s.general.notifications} onChange={(v) => updateSettings({ general: { notifications: v } })} />
        </Option>
        <Option title="Opening animation" hint="Show the brief intro each time the app opens.">
          <Switch label="Opening animation" checked={s.general.showIntro} onChange={(v) => updateSettings({ general: { showIntro: v } })} />
        </Option>
        <Option title="Onboarding" hint="Walk through the setup screens again.">
          <button
            className="soft"
            onClick={() => {
              useStore.setState({ settingsOpen: null, onboardingOpen: true });
            }}
          >
            Show again
          </button>
        </Option>
      </div>
    </>
  );
}

function DevicesTab() {
  const snap = useStore((x) => x.devices);
  const selectedId = useStore((x) => x.selectedDeviceId);
  const simBusy = useStore((x) => x.sim.phase !== "idle" && x.sim.phase !== "failed");
  const s = useStore((x) => x.settings);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pmd, setPmd] = useState(s.devices.pymobiledevice3Path);
  const [adb, setAdb] = useState(s.devices.adbPath);
  const loadLogs = () => void api.diagnostics.logs().then(setLogs);
  useEffect(loadLogs, []);

  const runAction = async (deviceId: string, action: "mount-ddi" | "recheck", label: string, description: string) => {
    if (action === "mount-ddi") {
      const c = await confirmAction({ title: `${label}?`, body: `${description} This runs pymobiledevice3 on your behalf and may take a minute.`, confirmLabel: "Mount" });
      if (!c.ok) return;
    }
    setBusy(deviceId + action);
    const r = await api.devices.runAction(deviceId, action);
    setBusy(null);
    toast(r.ok ? r.value : r.error, r.ok ? "success" : "error");
    loadLogs();
  };

  return (
    <>
      <div className="card">
        <h2 style={{ justifyContent: "space-between" }}>
          Connected devices
          <button className="soft" onClick={() => api.devices.refresh().then(loadLogs)} disabled={snap.scanning}>
            {snap.scanning ? <span className="spinner" /> : <RefreshCw />} Refresh
          </button>
        </h2>
        {snap.devices.length === 0 && <p>No simulators or devices detected. Boot a simulator, start an emulator or connect a device, then refresh.</p>}
        {snap.devices.map((d) => (
          <div className="adapter-row" key={d.id} data-testid="settings-device">
            <StatusDot state={d.state} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>
                {d.name} {d.isTest && <span className="badge">Test</span>}{" "}
                {d.id === selectedId && <span className="badge inverse">In use</span>}
              </strong>
              <p className="muted" style={{ fontSize: 11.5 }}>
                {STATE_TEXT[d.state]} · {deviceSubtitle(d)}
                {d.model ? ` · ${d.model}` : ""}
              </p>
              {d.stateDetail && <p style={{ fontSize: 11.5 }}>{d.stateDetail}</p>}
              {d.guidance && <p style={{ fontSize: 11.5 }}>{d.guidance}</p>}
              <p style={{ fontSize: 11 }}>
                ID <code>{d.nativeId}</code> · {d.restoresOnStop ? "Stop restores the real location" : "Keeps its last position after stop"}
              </p>
              {(d.actions || (d.state === "connected" && d.id !== selectedId)) && (
                <div className="actions" style={{ marginTop: 8 }}>
                  {d.state === "connected" && d.id !== selectedId && (
                    <button
                      className="soft"
                      disabled={simBusy}
                      title={simBusy ? "Stop the current simulation to switch devices" : `Simulate on ${d.name}`}
                      onClick={() => {
                        chooseDevice(d.id);
                        toast(`Using ${d.name}.`, "success");
                      }}
                      data-testid="use-device"
                    >
                      Use this device
                    </button>
                  )}
                  {d.actions?.map((a) => (
                    <button key={a.id} className="soft" title={a.description} disabled={busy !== null} onClick={() => runAction(d.id, a.id, a.label, a.description)}>
                      {busy === d.id + a.id && <span className="spinner" />} {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Integrations on this computer</h2>
        {snap.adapters.map((a) => (
          <div className="adapter-row" key={a.adapterId} data-testid="settings-adapter">
            <StatusDot state={a.available ? "connected" : a.platformSupported ? "disconnected" : "unsupported"} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>{a.label}</strong>{" "}
              <span className="badge">{a.available ? "Available" : a.platformSupported ? "Not installed" : "Unsupported OS"}</span>
              <p className="muted" style={{ fontSize: 11.5 }}>
                {a.detail}
              </p>
              {a.guidance && <p style={{ fontSize: 11.5 }}>{a.guidance}</p>}
              {a.toolPath && (
                <p style={{ fontSize: 11 }}>
                  <code>{a.toolPath}</code> {a.toolVersion && <span className="muted">· {a.toolVersion}</span>}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Connection preferences</h2>
        <Option title="Watch for devices" hint="Scan for simulators and devices in the background. Scans slow down while the window is hidden.">
          <Switch label="Watch for devices" checked={s.devices.autoRefresh} onChange={(v) => updateSettings({ devices: { autoRefresh: v } })} />
        </Option>
        <Option title="Scan interval">
          <div style={{ width: 150 }}>
            <SelectMenu
              label="Scan interval"
              value={String(s.devices.refreshIntervalSec)}
              options={["2", "4", "8", "15", "30"].map((v) => ({ value: v, label: `Every ${v} s` }))}
              onChange={(v) => updateSettings({ devices: { refreshIntervalSec: Number(v) } })}
            />
          </div>
        </Option>
        <Option title="iOS 17+ connection" hint="How pymobiledevice3 reaches iOS 17+ devices. Automatic lets it choose; tunneld needs the tunnel daemon already running.">
          <div style={{ width: 170 }}>
            <SelectMenu<Settings["devices"]["iosTunnel"]>
              label="iOS 17+ connection"
              value={s.devices.iosTunnel}
              options={[
                { value: "auto", label: "Automatic" },
                { value: "userspace", label: "Userspace tunnel" },
                { value: "tunneld", label: "tunneld" },
              ]}
              onChange={(v) => updateSettings({ devices: { iosTunnel: v } })}
            />
          </div>
        </Option>
        <div className="fields" style={{ marginTop: 14 }}>
          <label className="label">
            <span>pymobiledevice3 path <span className="faint">(optional)</span></span>
            <input className="field" style={{ height: 39 }} value={pmd} placeholder="Found automatically on PATH" onChange={(e) => setPmd(e.target.value)} onBlur={() => pmd !== s.devices.pymobiledevice3Path && updateSettings({ devices: { pymobiledevice3Path: pmd.trim() } })} />
          </label>
          <label className="label">
            <span>adb path <span className="faint">(optional)</span></span>
            <input className="field" style={{ height: 39 }} value={adb} placeholder="Found automatically on PATH" onChange={(e) => setAdb(e.target.value)} onBlur={() => adb !== s.devices.adbPath && updateSettings({ devices: { adbPath: adb.trim() } })} />
          </label>
        </div>
        <div style={{ marginTop: 14 }}>
          <Option title="Show loopback test adapter" hint="Adds a clearly labelled test device that exercises the full pipeline without changing any real device's location.">
            <Switch label="Show loopback test adapter" checked={s.devices.showTestAdapter} onChange={(v) => updateSettings({ devices: { showTestAdapter: v } })} />
          </Option>
        </div>
      </div>

      <div className="card">
        <h2 style={{ justifyContent: "space-between" }}>
          Diagnostics
          <span className="actions">
            <button className="soft" onClick={loadLogs}>
              <RefreshCw /> Reload
            </button>
            <button
              className="soft"
              onClick={async () => {
                await api.diagnostics.copy(await api.diagnostics.report());
                toast("Diagnostic report copied (coordinates redacted).", "success");
              }}
            >
              <Copy /> Copy report
            </button>
          </span>
        </h2>
        <div className="log" data-testid="log">
          {logs.length === 0
            ? "No log entries yet."
            : logs
                .slice(-150)
                .map((l) => `${new Date(l.t).toLocaleTimeString()}  ${l.level.toUpperCase().padEnd(5)} [${l.scope}] ${l.msg}`)
                .join("\n")}
        </div>
      </div>

      <div className="card">
        <h2>Compatibility</h2>
        <table className="matrix">
          <thead>
            <tr>
              <th>Target</th>
              <th>macOS</th>
              <th>Windows</th>
              <th>Requires</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>iOS Simulator</td>
              <td>Yes</td>
              <td>No</td>
              <td>Xcode 14+ (simctl location)</td>
            </tr>
            <tr>
              <td>iPhone / iPad, iOS 17+</td>
              <td>Yes</td>
              <td>Yes*</td>
              <td>pymobiledevice3, Developer Mode, trusted pairing, developer disk image</td>
            </tr>
            <tr>
              <td>iPhone / iPad, iOS ≤ 16</td>
              <td>Yes</td>
              <td>Yes*</td>
              <td>pymobiledevice3, developer disk image (Developer Mode on iOS 16)</td>
            </tr>
            <tr>
              <td>Android Emulator</td>
              <td>Yes</td>
              <td>Yes</td>
              <td>Android SDK platform-tools (adb)</td>
            </tr>
            <tr>
              <td>Physical Android</td>
              <td>No</td>
              <td>No</td>
              <td>Needs an on-device mock-location app (not provided)</td>
            </tr>
          </tbody>
        </table>
        <p style={{ marginTop: 10, fontSize: 11 }}>* Windows also needs Apple Mobile Device Support. iPhone connection was verified on an iPhone 15 Pro (iOS 27); the Simulator, Android Emulator and Windows paths are verified only against stand-in tools.</p>
      </div>
    </>
  );
}

function LocationTab() {
  const s = useStore((x) => x.settings);
  const [custom, setCustom] = useState(String(s.location.customSpeedKmh));
  return (
    <>
      <div className="card">
        <h2>Movement</h2>
        <div className="fields">
          <div className="label">
            Default movement
            <SelectMenu<Settings["location"]["defaultMode"]>
              label="Default movement"
              value={s.location.defaultMode}
              options={[
                { value: "walk", label: `Walking · ${formatSpeed(5, s.location.units)}` },
                { value: "cycle", label: `Cycling · ${formatSpeed(16, s.location.units)}` },
                { value: "drive", label: `Driving · ${formatSpeed(50, s.location.units)}` },
                { value: "custom", label: "Custom speed" },
              ]}
              onChange={(v) => {
                void updateSettings({ location: { defaultMode: v } });
                useStore.setState((st) => ({ route: { ...st.route, mode: v } }));
              }}
            />
          </div>
          <label className="label">
            Custom speed (km/h)
            <input
              className="field"
              style={{ height: 39 }}
              type="number"
              min={MIN_SPEED_KMH}
              max={MAX_SPEED_KMH}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onBlur={() => {
                const v = Math.min(MAX_SPEED_KMH, Math.max(MIN_SPEED_KMH, Number(custom) || 30));
                setCustom(String(v));
                void updateSettings({ location: { customSpeedKmh: v } });
              }}
            />
          </label>
          <div className="label">
            Route paths
            <SelectMenu<Settings["location"]["defaultPathMode"]>
              label="Route paths"
              value={s.location.defaultPathMode}
              options={[
                { value: "roads", label: "Follow roads (OSRM)" },
                { value: "direct", label: "Straight lines" },
              ]}
              onChange={(v) => updateSettings({ location: { defaultPathMode: v } })}
            />
          </div>
          <div className="label">
            Route update interval
            <SelectMenu
              label="Route update interval"
              value={String(s.location.updateIntervalMs)}
              options={[
                { value: "500", label: "Every 0.5 s (smoothest)" },
                { value: "1000", label: "Every 1 s" },
                { value: "2000", label: "Every 2 s (lightest)" },
              ]}
              onChange={(v) => updateSettings({ location: { updateIntervalMs: Number(v) } })}
            />
          </div>
        </div>
      </div>
      <div className="card">
        <h2>Display</h2>
        <div className="fields">
          <div className="label">
            Distance units
            <SelectMenu<Settings["location"]["units"]>
              label="Distance units"
              value={s.location.units}
              options={[
                { value: "metric", label: "Metric (km, m)" },
                { value: "imperial", label: "Imperial (mi, ft)" },
              ]}
              onChange={(v) => updateSettings({ location: { units: v } })}
            />
          </div>
          <div className="label">
            Coordinate format
            <SelectMenu<Settings["location"]["coordFormat"]>
              label="Coordinate format"
              value={s.location.coordFormat}
              options={[
                { value: "decimal", label: "Decimal (40.689247)" },
                { value: "dms", label: "Degrees (40°41′21.3″N)" },
              ]}
              onChange={(v) => updateSettings({ location: { coordFormat: v } })}
            />
          </div>
        </div>
      </div>
      <div className="card">
        <h2>Simulation</h2>
        <Option title="Confirm before starting" hint="Ask before a location is sent to a device.">
          <Switch label="Confirm before starting" checked={s.location.confirmBeforeStart} onChange={(v) => updateSettings({ location: { confirmBeforeStart: v } })} />
        </Option>
        <Option title="Keep this computer awake" hint="Prevent sleep while a simulation is running, so routes and schedules keep going.">
          <Switch label="Keep computer awake" checked={s.location.keepAwake} onChange={(v) => updateSettings({ location: { keepAwake: v } })} />
        </Option>
        <Option title="Stop when ryxnroam closes" hint="Always on. Closing or quitting the app stops the simulation and restores the device location where the platform allows.">
          <Switch label="Stop when the app closes" checked disabled onChange={() => {}} />
        </Option>
      </div>
    </>
  );
}

function DataTab() {
  const lib = useStore((x) => x.library);
  const history = useStore((x) => x.history);
  const schedules = useStore((x) => x.schedules);
  const info = useStore((x) => x.info);
  return (
    <>
      <div className="card">
        <h2>Your data</h2>
        <dl className="kv">
          <dt>Saved locations</dt>
          <dd>{lib.favorites.length}</dd>
          <dt>Saved routes</dt>
          <dd>{lib.routes.length}</dd>
          <dt>History entries</dt>
          <dd>{history.length}</dd>
          <dt>Schedules</dt>
          <dd>{schedules.length}</dd>
          <dt>Stored in</dt>
          <dd>
            <code>{info?.userDataPath}</code>
          </dd>
        </dl>
        <p style={{ marginTop: 12 }}>Everything stays on this computer. ryxnroam has no account and sends no telemetry.</p>
      </div>
      <div className="card">
        <h2>Export & import</h2>
        <p>Export saved locations and routes to a JSON file, or import a file exported from ryxnroam. Imports add new items and never overwrite existing ones.</p>
        <div className="actions">
          <button
            className="soft"
            onClick={async () => {
              const r = await api.data.exportAll();
              if (r.ok) toast("Export saved.", "success");
              else if (r.code !== "cancelled") toast(r.error, "error");
            }}
          >
            <Upload /> Export…
          </button>
          <button
            className="soft"
            onClick={async () => {
              const r = await api.data.importAll();
              if (r.ok) toast(`Imported ${r.value.favorites} locations and ${r.value.routes} routes (duplicates skipped).`, "success");
              else if (r.code !== "cancelled") toast(r.error, "error");
            }}
          >
            <Download /> Import…
          </button>
        </div>
      </div>
      <div className="card">
        <h2>History</h2>
        <p>Simulation history records when and where you simulated, on which device and how it ended.</p>
        <button
          className="soft danger"
          disabled={history.length === 0}
          onClick={async () => {
            const r = await confirmAction({ title: "Clear history?", body: "All past simulation records are removed from this computer.", confirmLabel: "Clear history", danger: true });
            if (r.ok) {
              await api.history.clear();
              toast("History cleared.");
            }
          }}
        >
          Clear history
        </button>
      </div>
    </>
  );
}

const LICENCES: [string, string, string][] = [
  ["ryxnroam", "MIT", ""],
  ["Electron", "MIT", "https://github.com/electron/electron"],
  ["React", "MIT", "https://github.com/facebook/react"],
  ["MapLibre GL JS", "BSD-3-Clause", "https://github.com/maplibre/maplibre-gl-js"],
  ["zustand", "MIT", "https://github.com/pmndrs/zustand"],
  ["Lucide icons", "ISC", "https://lucide.dev"],
  ["electron-updater", "MIT", "https://github.com/electron-userland/electron-builder"],
];

function AboutTab() {
  const info = useStore((x) => x.info);
  const update = useStore((x) => x.update);
  const open = (url: string) => () => api.app.openExternal(url);
  return (
    <>
      <div className="card" style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <BrandEmblem />
        <div style={{ flex: 1 }}>
          <div className="wordmark" style={{ fontSize: 21 }}>
            ryxnroam
          </div>
          <small className="muted">Location simulation studio · version {info?.version}</small>
        </div>
      </div>
      <div className="card">
        <h2 style={{ justifyContent: "space-between" }}>
          Updates
          <span className="actions">
            {update.state === "available" && (
              <button className="soft" onClick={() => api.updates.download()}>
                <Download /> Download {update.version}
              </button>
            )}
            {update.state === "ready" && (
              <button className="soft" onClick={() => api.updates.install()}>
                Restart to update
              </button>
            )}
            <button className="soft" onClick={() => api.updates.check()} disabled={update.state === "checking" || update.state === "downloading"} data-testid="check-updates">
              {update.state === "checking" ? <span className="spinner" /> : <RefreshCw />} Check for updates
            </button>
          </span>
        </h2>
        <p data-testid="update-status">
          {update.state === "idle" && "Updates are published on GitHub Releases. Nothing is downloaded without your click."}
          {update.state === "checking" && "Checking GitHub Releases…"}
          {update.state === "unavailable" && update.detail}
          {update.state === "up-to-date" && `You're on the latest version (${update.version}).`}
          {update.state === "available" && `Version ${update.version} is available.`}
          {update.state === "downloading" && `Downloading… ${update.percent}%`}
          {update.state === "ready" && `Version ${update.version} is ready to install.`}
          {update.state === "error" && `Update check failed: ${update.message}`}
        </p>
        {update.state === "downloading" && <progress value={update.percent} max={100} style={{ width: "100%", accentColor: "currentColor" }} />}
      </div>
      <div className="card">
        <h2>Build</h2>
        <dl className="kv">
          <dt>Version</dt>
          <dd>{info?.version}</dd>
          <dt>Build</dt>
          <dd>
            {info?.packaged ? "Installed" : "Development"} · {info?.buildDate} · {info?.commit}
          </dd>
          <dt>Platform</dt>
          <dd>
            {info?.platform} {info?.arch}
          </dd>
          <dt>Electron</dt>
          <dd>
            {info?.electron} · Chromium {info?.chrome} · Node {info?.node}
          </dd>
        </dl>
      </div>
      <div className="card">
        <h2>Licences & attribution</h2>
        <dl className="kv">
          {LICENCES.map(([n, l, url]) => (
            <div key={n} style={{ display: "contents" }}>
              <dt>{url ? <button className="text-btn" onClick={open(url)}>{n}</button> : n}</dt>
              <dd>{l}</dd>
            </div>
          ))}
        </dl>
        <p style={{ marginTop: 14 }}>
          Map data © OpenStreetMap contributors (ODbL). Vector tiles by OpenFreeMap with the OpenMapTiles schema. Search by Photon (komoot) and Nominatim; road routing by the FOSSGIS OSRM servers.
        </p>
        <p>
          Optional device tools are separate programs you install yourself and are not bundled: Xcode's simctl (Apple), adb (Android SDK, Apache-2.0) and pymobiledevice3 (GPL-3.0). ryxnroam runs them as external commands. For iOS 17+ it also ships a small helper program, licensed GPL-3.0-or-later (licence text in the app's helpers folder), that runs with your pymobiledevice3.
        </p>
        <p>
          Product research referenced LocationSimulator (GPL-3.0) and GhostMe; no code or assets from either are included.
        </p>
      </div>
    </>
  );
}
