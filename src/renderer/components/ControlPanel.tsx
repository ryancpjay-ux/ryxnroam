import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Bike,
  Car,
  Copy,
  Crosshair,
  Eye,
  Footprints,
  Gauge,
  Info,
  MapPin,
  Navigation,
  Pause,
  Play,
  Route as RouteIcon,
  Save,
  ShieldCheck,
  Square,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { formatLatLng, parseCoordinates } from "../../shared/coords";
import { MAX_SPEED_KMH, MIN_SPEED_KMH, formatDistance, formatDuration, formatSpeed, speedKmh } from "../../shared/geo";
import type { MovementMode } from "../../shared/types";
import { api } from "../api";
import { Toasts } from "./Overlays";
import {
  clearRoute,
  fitPoints,
  flyTo,
  recomputeRoute,
  removeStop,
  reorderStop,
  routeSpeedKmh,
  selectPoint,
  selectedDevice,
  setRoute,
  startLocation,
  startRoute,
  stopSimulation,
  toast,
  useStore,
} from "../store";

const MODES: { id: MovementMode; label: string; icon: typeof Car }[] = [
  { id: "walk", label: "Walk", icon: Footprints },
  { id: "cycle", label: "Cycle", icon: Bike },
  { id: "drive", label: "Drive", icon: Car },
  { id: "custom", label: "Custom", icon: Gauge },
];

export function ControlPanel() {
  const mode = useStore((s) => s.mode);
  const sim = useStore((s) => s.sim);
  const routeBusy = sim.kind === "route" && sim.phase !== "idle" && sim.phase !== "failed";
  return (
    <section className="control glass" aria-label="Simulation controls" data-testid="control-panel">
      <div className="control-head">
        <div className="segmented" role="tablist" aria-label="Mode">
          <button
            role="tab"
            aria-selected={mode === "location"}
            data-testid="mode-location"
            onClick={() => useStore.setState({ mode: "location" })}
          >
            <MapPin /> Location
          </button>
          <button role="tab" aria-selected={mode === "route"} data-testid="mode-route" onClick={() => useStore.setState({ mode: "route" })}>
            <RouteIcon /> Route
          </button>
        </div>
        <span className="hint">
          {mode === "location" ? (
            <>
              <Crosshair size={12} /> Click the map to choose · right-click for more
            </>
          ) : routeBusy ? (
            <>
              <Info size={12} /> Route is running — stop it to edit stops
            </>
          ) : (
            <>
              <Crosshair size={12} /> Click the map to add stops · drag to adjust
            </>
          )}
        </span>
      </div>
      {mode === "location" ? <LocationControls /> : <RouteControls />}
      <Toasts placement="stage" />
    </section>
  );
}

function CoordInputs() {
  const selection = useStore((s) => s.selection);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  useEffect(() => {
    setLat(selection ? selection.point.lat.toFixed(6) : "");
    setLng(selection ? selection.point.lng.toFixed(6) : "");
  }, [selection?.point]);
  const latN = Number(lat);
  const lngN = Number(lng);
  const latBad = lat !== "" && !(Number.isFinite(latN) && Math.abs(latN) <= 90);
  const lngBad = lng !== "" && !(Number.isFinite(lngN) && Math.abs(lngN) <= 180);
  const commit = () => {
    if (latBad || lngBad || lat === "" || lng === "") return;
    if (selection && latN === selection.point.lat && lngN === selection.point.lng) return;
    selectPoint({ lat: latN, lng: lngN }, { source: "coords" }, { fly: true });
  };
  // Moving between the two fields isn't "done": commit only when focus leaves the pair.
  const onBlur = (e: React.FocusEvent) => {
    if ((e.relatedTarget as HTMLElement | null)?.closest(".coords")) return;
    commit();
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const p = parseCoordinates(e.clipboardData.getData("text"));
    if (p) {
      e.preventDefault();
      selectPoint(p, { source: "coords" }, { fly: true, zoom: 15 });
    }
  };
  return (
    <div className="coords">
      <div className="coord-field">
        <label htmlFor="lat">Latitude</label>
        <input
          id="lat"
          inputMode="decimal"
          value={lat}
          aria-invalid={latBad}
          placeholder="0.000000"
          data-testid="lat-input"
          onChange={(e) => setLat(e.target.value)}
          onBlur={onBlur}
          onPaste={onPaste}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
      </div>
      <div className="coord-field">
        <label htmlFor="lng">Longitude</label>
        <input
          id="lng"
          inputMode="decimal"
          value={lng}
          aria-invalid={lngBad}
          placeholder="0.000000"
          data-testid="lng-input"
          onChange={(e) => setLng(e.target.value)}
          onBlur={onBlur}
          onPaste={onPaste}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
      </div>
    </div>
  );
}

function LocationControls() {
  const selection = useStore((s) => s.selection);
  const sim = useStore((s) => s.sim);
  const fmt = useStore((s) => s.settings.location.coordFormat);
  const favorites = useStore((s) => s.library.favorites);
  useStore((s) => s.devices);
  useStore((s) => s.selectedDeviceId);
  const device = selectedDevice();
  const busy = sim.phase === "starting" || sim.phase === "stopping";
  const activeHere = sim.phase === "active" && sim.kind === "location" && sim.deviceId === device?.id;
  const running = sim.phase === "active" || sim.phase === "paused" || busy;
  const saved = selection && favorites.find((f) => Math.abs(f.point.lat - selection.point.lat) < 1e-6 && Math.abs(f.point.lng - selection.point.lng) < 1e-6);
  const sameAsApplied =
    activeHere && selection && sim.appliedPosition && Math.abs(sim.appliedPosition.lat - selection.point.lat) < 1e-7 && Math.abs(sim.appliedPosition.lng - selection.point.lng) < 1e-7;
  const canStart = !!selection && !!device && device.state === "connected" && !busy && !sameAsApplied;
  const startTitle = !device
    ? "Connect a simulator or test device first"
    : device.state !== "connected"
      ? device.stateDetail ?? "Device not ready"
      : !selection
        ? "Choose a location first"
        : undefined;

  return (
    <>
      {selection ? (
        <div className="control-row">
          <div className="place">
            <strong data-testid="selection-name">
              {selection.resolving ? "Finding address…" : selection.name ?? "Dropped pin"}
            </strong>
            <small className="num">{selection.detail ?? formatLatLng(selection.point, fmt)}</small>
          </div>
          <CoordInputs />
          <button
            className="icon-btn"
            title={saved ? `Saved as “${saved.name}”` : "Save location"}
            aria-label="Save location"
            data-testid="save-location"
            onClick={() =>
              useStore.setState({
                favoriteEditor: saved
                  ? { id: saved.id, name: saved.name, point: saved.point, address: saved.address, group: saved.group, note: saved.note }
                  : { name: selection.name ?? "", point: selection.point, address: selection.detail },
              })
            }
          >
            <Star fill={saved ? "currentColor" : "none"} />
          </button>
          <button
            className="icon-btn"
            title="Copy coordinates"
            aria-label="Copy coordinates"
            onClick={async () => {
              await api.diagnostics.copy(`${selection.point.lat.toFixed(6)}, ${selection.point.lng.toFixed(6)}`);
              toast("Coordinates copied.");
            }}
          >
            <Copy />
          </button>
        </div>
      ) : (
        <div className="control-row">
          <div className="control-empty" style={{ flex: 1 }}>
            <Crosshair />
            <span>Click anywhere on the map, search for a place, or type coordinates to choose a location.</span>
          </div>
          <CoordInputs />
        </div>
      )}
      <div className="control-actions">
        <button className="soft" disabled={!selection} onClick={() => selection && flyTo(selection.point, 16)} data-testid="preview-button">
          <Eye /> Preview
        </button>
        {selection && (
          <button className="soft" title="Clear selection" onClick={() => useStore.setState({ selection: null })}>
            <X /> Clear
          </button>
        )}
        <span className="grow" />
        {running && (
          <button className="secondary" onClick={() => void stopSimulation()} disabled={sim.phase === "stopping"} data-testid="stop-button">
            <Square /> {sim.phase === "stopping" ? "Restoring…" : "Stop simulation"}
          </button>
        )}
        <button className="primary" disabled={!canStart} title={startTitle} onClick={() => void startLocation()} data-testid="start-button">
          {sim.phase === "starting" && sim.kind === "location" ? <span className="spinner" /> : sameAsApplied ? <ShieldCheck /> : <Navigation />}
          {sim.phase === "starting" && sim.kind === "location" ? "Waiting for device…" : sameAsApplied ? "Applied" : activeHere ? "Move here" : "Start simulation"}
        </button>
      </div>
      <div className="control-foot" data-testid="location-foot">
        {sameAsApplied ? (
          <>
            <ShieldCheck /> Applied on {sim.deviceName}
            {sim.confirmation === "holding" ? " · confirmed by the device, held while ryxnroam stays open and connected" : sim.confirmation === "test" ? " · test adapter, no real device" : " · confirmed by the device tool"}
          </>
        ) : selection ? (
          <>
            <Eye /> Preview only — nothing is sent to {device?.isTest ? "the test adapter" : device ? device.name : "a device"} until you start.
          </>
        ) : device && device.state !== "connected" ? (
          <>
            <Info /> {device.name}: {device.stateDetail ?? "not ready"} {device.guidance}
          </>
        ) : (
          <>
            <Info /> {device ? `Ready on ${device.name}.` : "No device connected — you can still explore and save places."}
          </>
        )}
      </div>
    </>
  );
}

function RouteControls() {
  const route = useStore((s) => s.route);
  const sim = useStore((s) => s.sim);
  const units = useStore((s) => s.settings.location.units);
  const fmt = useStore((s) => s.settings.location.coordFormat);
  useStore((s) => s.devices);
  useStore((s) => s.selectedDeviceId);
  const device = selectedDevice();
  const running = sim.kind === "route" && (sim.phase === "active" || sim.phase === "paused" || sim.phase === "starting");
  const busy = sim.phase === "starting" || sim.phase === "stopping";
  const progress = running ? sim.route : null;
  const kmh = running && progress ? progress.speedMps * 3.6 : routeSpeedKmh();
  const distance = progress?.totalMeters ?? route.computed?.distanceMeters ?? 0;
  const estMs = distance > 0 ? (distance / (kmh / 3.6)) * 1000 : 0;
  const canStart = !!route.computed && !!device && device.state === "connected" && !busy && !route.computing;

  const changeMode = (m: MovementMode) => {
    setRoute({ mode: m }, route.pathMode === "roads");
    if (running) void api.simulation.setSpeed(speedKmh(m, route.customKmh), m);
  };
  const changeCustom = (v: number) => {
    setRoute({ customKmh: v });
    if (running && route.mode === "custom") void api.simulation.setSpeed(v, "custom");
  };

  return (
    <>
      <div className="route-grid">
        <div>
          {route.stops.length === 0 && !running ? (
            <div className="control-empty" style={{ minHeight: 80 }}>
              <RouteIcon />
              <span>Click the map to place a start (A), then a destination (B). Add more clicks for waypoints.</span>
            </div>
          ) : (
            <div className="stops scroll" data-testid="stops">
              {(running && progress ? progress.stops : route.stops).map((s, i, arr) => (
                <div className="stop-row" key={s.id}>
                  <span className={`stop-badge ${i === arr.length - 1 && arr.length > 1 ? "end" : ""}`}>
                    {i === 0 ? "A" : i === arr.length - 1 ? "B" : i}
                  </span>
                  <span className="grow num" title={formatLatLng(s.point, fmt)}>
                    {s.name ?? formatLatLng(s.point, fmt)}
                  </span>
                  {!running && (
                    <span className="item-actions">
                      <button className="icon-btn sm" title="Move up" aria-label="Move stop up" disabled={i === 0} onClick={() => reorderStop(s.id, -1)}>
                        <ArrowUp />
                      </button>
                      <button className="icon-btn sm" title="Move down" aria-label="Move stop down" disabled={i === arr.length - 1} onClick={() => reorderStop(s.id, 1)}>
                        <ArrowDown />
                      </button>
                      <button className="icon-btn sm" title="Remove stop" aria-label="Remove stop" onClick={() => removeStop(s.id)}>
                        <X />
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {!running && route.stops.length > 0 && (
            <div className="actions" style={{ marginTop: 8 }}>
              <button
                className="soft"
                disabled={route.stops.length < 2}
                onClick={() => setRoute({ stops: route.stops.slice().reverse(), savedId: null }, true)}
              >
                <ArrowUpDown /> Reverse
              </button>
              <button className="soft" onClick={() => fitPoints(route.computed?.geometry ?? route.stops.map((s) => s.point))}>
                <Eye /> Preview
              </button>
              <button className="soft danger" onClick={clearRoute}>
                <Trash2 /> Clear
              </button>
            </div>
          )}
        </div>
        <div className="route-side">
          <div className="segmented" role="group" aria-label="Movement mode" style={{ alignSelf: "flex-start" }}>
            {MODES.map((m) => (
              <button key={m.id} aria-pressed={route.mode === m.id} onClick={() => changeMode(m.id)} title={m.id === "custom" ? "Custom speed" : `${m.label} · ${formatSpeed(speedKmh(m.id, 0), units)}`}>
                <m.icon /> {m.label}
              </button>
            ))}
          </div>
          {route.mode === "custom" ? (
            <div className="speed-row">
              <input
                type="range"
                min={MIN_SPEED_KMH}
                max={150}
                step={1}
                value={Math.min(150, route.customKmh)}
                aria-label="Custom speed"
                onChange={(e) => changeCustom(Number(e.target.value))}
              />
              <input
                className="field"
                type="number"
                min={MIN_SPEED_KMH}
                max={MAX_SPEED_KMH}
                value={route.customKmh}
                aria-label="Custom speed in km/h"
                onChange={(e) => changeCustom(Math.min(MAX_SPEED_KMH, Math.max(MIN_SPEED_KMH, Number(e.target.value) || MIN_SPEED_KMH)))}
              />
              <span className="muted">km/h</span>
            </div>
          ) : (
            <div className="speed-row muted">Speed {formatSpeed(kmh, units)}</div>
          )}
          <div className="toggles">
            <label className="check" title="Follow roads and paths (OSRM) or move in straight lines">
              <input
                type="checkbox"
                checked={route.pathMode === "roads"}
                disabled={running}
                onChange={(e) => setRoute({ pathMode: e.target.checked ? "roads" : "direct" }, true)}
              />
              Follow roads
            </label>
            <label className="check">
              <input type="checkbox" checked={route.loop} disabled={running} onChange={(e) => setRoute({ loop: e.target.checked })} />
              Loop route
            </label>
          </div>
        </div>
      </div>

      <div className="control-actions" style={{ marginTop: 14 }}>
        <div className="summary" data-testid="route-summary">
          <div>
            <span>Distance</span>
            <b>{route.computing && !running ? "…" : distance ? formatDistance(distance, units) : "—"}</b>
          </div>
          {progress ? (
            <>
              <div>
                <span>Travelled</span>
                <b>{formatDistance(progress.traveledMeters, units)}</b>
              </div>
              <div>
                <span>Remaining</span>
                <b>{formatDuration(progress.remainingMs)}</b>
              </div>
              <div>
                <span>Arrives</span>
                <b>{progress.progress >= 1 ? "Arrived" : progress.etaAt ? new Date(progress.etaAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "Paused"}</b>
              </div>
              {progress.loop && (
                <div>
                  <span>Laps</span>
                  <b>{progress.laps}</b>
                </div>
              )}
            </>
          ) : (
            <div>
              <span>Est. time</span>
              <b>{estMs ? formatDuration(estMs) : "—"}</b>
            </div>
          )}
        </div>
        <span className="grow" />
        {!running && route.stops.length >= 2 && (
          <button className="soft" disabled={!route.computed} onClick={() => useStore.setState({ routeNamer: true })} data-testid="save-route">
            <Save /> {route.savedId ? "Saved" : "Save route"}
          </button>
        )}
        {running && sim.phase === "active" && progress && progress.progress < 1 && (
          <button className="secondary" onClick={() => api.simulation.pause().then((r) => !r.ok && toast(r.error, "error"))} data-testid="pause-button">
            <Pause /> Pause
          </button>
        )}
        {running && sim.phase === "paused" && (
          <button className="secondary" onClick={() => api.simulation.resume().then((r) => !r.ok && toast(r.error, "error"))} data-testid="resume-button">
            <Play /> Resume
          </button>
        )}
        {running ? (
          <button className="primary" onClick={() => void stopSimulation()} disabled={sim.phase === "stopping"} data-testid="stop-route">
            <Square /> Stop
          </button>
        ) : (
          <button
            className="primary"
            disabled={!canStart}
            title={!device ? "Connect a simulator or test device first" : !route.computed ? "Add at least two stops" : undefined}
            onClick={() => void startRoute()}
            data-testid="start-route"
          >
            {sim.phase === "starting" ? <span className="spinner" /> : <Play />} Start route
          </button>
        )}
      </div>
      {progress && (
        <div className="progress" style={{ marginTop: 10 }} aria-label="Route progress" role="progressbar" aria-valuenow={Math.round(progress.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${progress.progress * 100}%` }} />
        </div>
      )}
      <div className="control-foot">
        {route.error && !running ? (
          <>
            <Info /> {route.error}{" "}
            <button className="text-btn" onClick={() => void recomputeRoute()}>
              Retry
            </button>
          </>
        ) : running && sim.confirmation === "playback" ? (
          <>
            <Info /> The device is replaying this route as GPX; the marker shows ryxnroam's estimate.
          </>
        ) : running && sim.isTest ? (
          <>
            <Info /> Test adapter — no real device location changes.
          </>
        ) : running ? (
          <>
            <ShieldCheck /> Each position is sent to {sim.deviceName} and confirmed before the marker advances.
          </>
        ) : route.computed?.fallbackReason ? (
          <>
            <Info /> {route.computed.fallbackReason}
          </>
        ) : route.computed ? (
          <>
            <Eye /> Preview only · {route.computed.provider === "osrm" ? "roads via OSRM (FOSSGIS) · © OpenStreetMap" : "straight lines between stops"}
          </>
        ) : (
          <>
            <Info /> Speeds: walk {formatSpeed(5, units)}, cycle {formatSpeed(16, units)}, drive {formatSpeed(50, units)}.
          </>
        )}
      </div>
    </>
  );
}
