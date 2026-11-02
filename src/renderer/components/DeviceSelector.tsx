import { Check, ChevronDown, FlaskConical, Info, Laptop, MonitorSmartphone, RefreshCw, Smartphone, TabletSmartphone } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DeviceInfo } from "../../shared/types";
import { api } from "../api";
import { chooseDevice, selectedDevice, toast, useStore } from "../store";
import { StatusDot } from "./primitives";

export const STATE_TEXT: Record<DeviceInfo["state"], string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  connecting: "Connecting",
  unsupported: "Unsupported",
  "permission-required": "Permission required",
};

export function DeviceIcon({ device }: { device: DeviceInfo | null }) {
  if (!device) return <MonitorSmartphone />;
  if (device.isTest) return <FlaskConical />;
  if (device.adapterId === "ios-simulator" || device.adapterId === "android-emulator") return <Laptop />;
  if (device.osName === "iPadOS") return <TabletSmartphone />;
  return <Smartphone />;
}

export function deviceSubtitle(d: DeviceInfo): string {
  const os = [d.osName, d.osVersion].filter(Boolean).join(" ");
  const via = d.adapterId === "ios-simulator" ? "Simulator" : d.adapterId === "android-emulator" ? "Emulator" : d.connection === "network" ? "Wi-Fi" : d.isTest ? "Test adapter" : "USB";
  return [os, via].filter(Boolean).join(" · ");
}

export function DeviceSelector() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const snapshot = useStore((s) => s.devices);
  const selectedId = useStore((s) => s.selectedDeviceId);
  const sim = useStore((s) => s.sim);
  const device = selectedDevice();
  const simBusy = sim.phase !== "idle" && sim.phase !== "failed";

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const firstScan = snapshot.lastScanAt === null;
  const unavailable = snapshot.adapters.filter((a) => !a.available);
  const groups: { label: string; items: DeviceInfo[] }[] = [
    { label: "Simulators & emulators", items: snapshot.devices.filter((d) => d.adapterId === "ios-simulator" || d.adapterId === "android-emulator") },
    { label: "Physical devices", items: snapshot.devices.filter((d) => d.adapterId === "ios-device") },
    { label: "Testing", items: snapshot.devices.filter((d) => d.isTest) },
  ].filter((g) => g.items.length);

  const refresh = async () => {
    await api.devices.refresh();
    toast("Device list refreshed.");
  };

  return (
    <div className="device-select" ref={root}>
      <button
        className="device-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choose device"
        data-testid="device-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="device-glyph">
          <DeviceIcon device={device} />
          <StatusDot state={device?.state ?? (firstScan ? "connecting" : "disconnected")} />
        </span>
        <span className="device-text">
          <strong>{device ? device.name : firstScan ? "Looking for devices…" : "No device"}</strong>
          <small>
            {device
              ? `${STATE_TEXT[device.state]} · ${deviceSubtitle(device)}`
              : firstScan
                ? "Checking simulators and connected devices"
                : "Connect a simulator or test device"}
          </small>
        </span>
        {snapshot.devices.filter((d) => d.state === "connected").length > 1 && <span className="switch-hint">Switch</span>}
        <ChevronDown size={14} className="faint" />
      </button>
      {open && (
        <div className="popover device-menu" role="menu" data-testid="device-menu">
          <div className="menu-label">
            <span>Devices</span>
            <button className="icon-btn sm" title="Refresh devices" aria-label="Refresh devices" onClick={refresh}>
              {snapshot.scanning ? <span className="spinner" /> : <RefreshCw />}
            </button>
          </div>
          {groups.length === 0 && (
            <div className="adapter-note">
              <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>{firstScan ? "Scanning…" : "No simulators or devices found. Boot a simulator or connect a device, then refresh."}</span>
            </div>
          )}
          {groups.map((g) => (
            <div key={g.label}>
              <div className="menu-label">{g.label}</div>
              {g.items.map((d) => (
                <button
                  key={d.id}
                  role="menuitemradio"
                  aria-checked={d.id === selectedId}
                  className={`menu-item ${d.id === selectedId ? "selected" : ""}`}
                  data-testid={`device-option-${d.nativeId}`}
                  disabled={simBusy && sim.deviceId !== d.id}
                  title={simBusy && sim.deviceId !== d.id ? "Stop the current simulation to switch devices" : undefined}
                  onClick={() => {
                    chooseDevice(d.id);
                    setOpen(false);
                  }}
                >
                  <StatusDot state={d.state} />
                  <span className="grow">
                    {d.name} {d.isTest && <span className="badge">Test</span>}
                    <small>
                      {STATE_TEXT[d.state]} · {deviceSubtitle(d)}
                      {d.state !== "connected" && d.stateDetail ? ` — ${d.stateDetail}` : ""}
                    </small>
                    {d.state !== "connected" && d.guidance && <small>{d.guidance}</small>}
                  </span>
                  {d.id === selectedId && <Check size={15} aria-label="In use" />}
                </button>
              ))}
            </div>
          ))}
          {unavailable.length > 0 && (
            <>
              <div className="menu-sep" />
              <div className="adapter-note">
                <StatusDot state="disconnected" className="" />
                <span>
                  <strong>Not set up:</strong> {unavailable.map((a) => a.label.replace(/ \(.*\)$/, "")).join(", ")}. Setup steps are in device details.
                </span>
              </div>
            </>
          )}
          <div className="menu-sep" />
          <button
            className="menu-item"
            onClick={() => {
              setOpen(false);
              useStore.setState({ settingsOpen: "devices" });
            }}
          >
            <Info size={14} />
            <span className="grow">Device details & diagnostics</span>
          </button>
        </div>
      )}
    </div>
  );
}
