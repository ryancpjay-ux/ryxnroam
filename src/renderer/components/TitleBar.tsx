import { Copy, Minus, Settings, Square, X } from "lucide-react";
import { formatLatLng } from "../../shared/coords";
import { api, platform } from "../api";
import { selectedDevice, useStore } from "../store";
import { BrandEmblem, StatusDot } from "./primitives";

const STATE_LABEL: Record<string, string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  connecting: "Connecting",
  unsupported: "Unsupported",
  "permission-required": "Permission required",
};

export function StatusPill() {
  const sim = useStore((s) => s.sim);
  const fmt = useStore((s) => s.settings.location.coordFormat);
  const scanning = useStore((s) => s.devices.scanning && s.devices.lastScanAt === null);
  useStore((s) => s.devices);
  useStore((s) => s.selectedDeviceId);
  const device = selectedDevice();
  const pos = sim.appliedPosition ?? sim.enginePosition;

  if (sim.phase === "active" || sim.phase === "paused" || sim.phase === "starting" || sim.phase === "stopping") {
    const label =
      sim.phase === "starting"
        ? "Connecting"
        : sim.phase === "stopping"
          ? "Restoring location"
          : sim.phase === "paused"
            ? "Route paused"
            : sim.isTest
              ? "Test simulation active"
              : "Simulation active";
    return (
      <div className="status-pill simulating" role="status" aria-live="polite" data-testid="status-pill">
        <StatusDot live={sim.phase === "active"} state={sim.phase === "starting" ? "connecting" : undefined} />
        <span>{label}</span>
        <span className="sep" />
        <small>{sim.deviceName}</small>
        {pos && sim.phase !== "starting" && (
          <>
            <span className="sep" />
            <small className="num">{formatLatLng(pos, fmt)}</small>
          </>
        )}
      </div>
    );
  }
  if (sim.phase === "failed") {
    return (
      <div className="status-pill" role="status" data-testid="status-pill">
        <StatusDot state="failed" />
        <span>Simulation failed</span>
        <span className="sep" />
        <small>{sim.error?.message}</small>
      </div>
    );
  }
  if (!device) {
    return (
      <div className="status-pill" role="status" data-testid="status-pill">
        <StatusDot state={scanning ? "connecting" : "disconnected"} />
        <span>{scanning ? "Looking for devices" : "No device connected"}</span>
      </div>
    );
  }
  return (
    <div className="status-pill" role="status" data-testid="status-pill">
      <StatusDot state={device.state} />
      <span>{device.name}</span>
      <span className="sep" />
      <small>{STATE_LABEL[device.state]}</small>
      {device.isTest && <span className="badge">Test</span>}
    </div>
  );
}

export function TitleBar() {
  const maximized = useStore((s) => s.windowMaximized);
  const mac = platform === "darwin";
  return (
    <header className="topline" onDoubleClick={(e) => e.target === e.currentTarget && api.app.window("maximize")}>
      <div className="brand">
        <BrandEmblem />
        <div className="brand-copy">
          <span className="wordmark">ryxnroam</span>
          <span className="tagline">Location simulation studio</span>
        </div>
      </div>
      <div className="topline-center">
        <StatusPill />
      </div>
      <div className="topline-actions">
        <button
          className="ctl"
          title={`Settings (${mac ? "⌘" : "Ctrl+"},)`}
          aria-label="Open settings"
          onClick={() => useStore.setState({ settingsOpen: "general" })}
        >
          <Settings />
        </button>
        <div className="window-controls">
          <button className="ctl" title="Minimize" aria-label="Minimize window" onClick={() => api.app.window("minimize")}>
            <Minus />
          </button>
          <button
            className="ctl"
            title={maximized ? "Restore" : "Maximize"}
            aria-label={maximized ? "Restore window" : "Maximize window"}
            onClick={() => api.app.window("maximize")}
          >
            {maximized ? <Copy /> : <Square />}
          </button>
          <button className="ctl" title="Close — stops any simulation" aria-label="Close window" onClick={() => api.app.window("close")}>
            <X />
          </button>
        </div>
      </div>
    </header>
  );
}
