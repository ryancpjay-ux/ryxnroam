import { Smartphone, TabletSmartphone } from "lucide-react";
import { useEffect, useState } from "react";
import type { DeviceInfo } from "../../shared/types";
import { api } from "../api";
import { toast, useStore } from "../store";
import { Modal, useModalClose } from "./primitives";

const DISMISSED_KEY = "ryxnroam.wifiPromptDismissed";

function dismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function remember(id: string) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...new Set([...dismissed(), id])]));
  } catch {
    /* storage unavailable: the prompt may show again next launch */
  }
}

/**
 * One-time offer, per device, to make an iPhone/iPad reachable over Wi-Fi —
 * the same switch as Finder's “Show this iPhone when on Wi-Fi” — so nobody
 * has to find it in Finder.
 */
export function WifiPrompt() {
  const devices = useStore((s) => s.devices.devices);
  const busy = useStore((s) => !!(s.settingsOpen || s.onboardingOpen || s.introVisible || s.confirm || s.favoriteEditor || s.scheduleEditor || s.routeNamer));
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  useEffect(() => {
    if (device || busy) return;
    const skip = new Set(dismissed());
    const candidate = devices.find((d) => d.adapterId === "ios-device" && d.connection === "usb" && d.wifi === "off" && d.state === "connected" && !skip.has(d.id));
    if (candidate) setDevice(candidate);
  }, [devices, busy, device]);
  if (!device) return null;
  return (
    <Modal onClose={() => setDevice(null)} className="small" label={`Use ${device.name} over Wi-Fi`}>
      <WifiPromptBody device={device} />
    </Modal>
  );
}

function WifiPromptBody({ device }: { device: DeviceInfo }) {
  const close = useModalClose();
  const [working, setWorking] = useState(false);
  const kind = device.osName === "iPadOS" ? "iPad" : "iPhone";
  const Icon = kind === "iPad" ? TabletSmartphone : Smartphone;
  return (
    <div style={{ textAlign: "center" }} data-testid="wifi-prompt">
      <div className="empty-mark" style={{ width: 56, height: 56, borderRadius: 16, margin: "6px auto 18px" }}>
        <Icon size={26} />
      </div>
      <div className="dialog-heading">
        <h1 style={{ fontSize: 20 }}>Use {kind} over Wi-Fi</h1>
        <p style={{ marginBottom: 0 }}>
          ryxnroam can reach {device.name} without a cable when both are on the same Wi-Fi. This turns on the same setting as Finder's “Show this {kind} when on Wi-Fi”. You can turn it off in Settings › Devices.
        </p>
      </div>
      <div className="dialog-actions" style={{ justifyContent: "center" }}>
        <button
          className="secondary"
          onClick={() => {
            remember(device.id);
            close();
          }}
        >
          Not now
        </button>
        <button
          className="primary"
          disabled={working}
          data-autofocus
          onClick={async () => {
            setWorking(true);
            const r = await api.devices.runAction(device.id, "enable-wifi");
            setWorking(false);
            remember(device.id);
            toast(r.ok ? r.value : r.error, r.ok ? "success" : "error");
            close();
          }}
        >
          {working ? <span className="spinner" /> : null} Turn on
        </button>
      </div>
    </div>
  );
}
