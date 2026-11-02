import { CalendarClock, Crosshair, Eye, Lock, MapPin, MousePointerClick, RefreshCw, Route as RouteIcon, Search, ShieldCheck, Smartphone, Star } from "lucide-react";
import { useState } from "react";
import { ONBOARDING_VERSION } from "../../shared/defaults";
import { api, platform } from "../api";
import { updateSettings, useStore } from "../store";
import { deviceSubtitle, STATE_TEXT } from "./DeviceSelector";
import { Modal, StatusDot, Switch } from "./primitives";

const STEPS = 5;

export function Onboarding() {
  const open = useStore((s) => s.onboardingOpen);
  if (!open) return null;
  return <OnboardingFlow />;
}

function OnboardingFlow() {
  const [step, setStep] = useState(0);
  const finish = () => {
    void updateSettings({ onboarding: { completedAt: Date.now(), version: ONBOARDING_VERSION } });
    useStore.setState({ onboardingOpen: false });
  };
  return (
    <Modal onClose={finish} className="onboarding" label="Welcome to ryxnroam">
      <div className="onb-body" key={step} data-testid={`onboarding-step-${step + 1}`}>
        <div className="onb-step">
          Step {step + 1} of {STEPS}
        </div>
        {step === 0 && <Welcome />}
        {step === 1 && <Platforms />}
        {step === 2 && <Connect />}
        {step === 3 && <Explore />}
        {step === 4 && <Ready />}
      </div>
      <div className="onb-foot">
        <div className="onb-dots" aria-hidden="true">
          {Array.from({ length: STEPS }, (_, i) => (
            <i key={i} className={i === step ? "on" : ""} />
          ))}
        </div>
        {step < STEPS - 1 && (
          <button className="text-btn" onClick={finish} data-testid="onboarding-skip">
            Skip
          </button>
        )}
        {step > 0 && (
          <button className="secondary" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {step < STEPS - 1 ? (
          <button className="primary" onClick={() => setStep(step + 1)} data-testid="onboarding-next">
            Continue
          </button>
        ) : (
          <button className="primary" onClick={finish} data-testid="onboarding-finish">
            Open the map
          </button>
        )}
      </div>
    </Modal>
  );
}

function Point({ icon: Icon, title, text }: { icon: typeof Star; title: string; text: string }) {
  return (
    <div className="onb-point">
      <Icon />
      <div>
        <strong>{title}</strong>
        <span>{text}</span>
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <>
      <h1>A calm studio for location testing.</h1>
      <p>Pick a place on a live map, preview it, then apply it to a simulator or a test device you're authorized to use — and stop to restore it.</p>
      <div className="onb-points">
        <Point icon={MapPin} title="Pick anywhere" text="Search, click the map or paste coordinates." />
        <Point icon={RouteIcon} title="Move along routes" text="Walk, cycle, drive or set your own speed." />
        <Point icon={CalendarClock} title="Plan ahead" text="Schedule saved places and routes with consent." />
        <Point icon={Lock} title="Stays local" text="No account, no telemetry. Your data stays here." />
      </div>
    </>
  );
}

function Platforms() {
  const adapters = useStore((s) => s.devices.adapters);
  return (
    <>
      <h1>What ryxnroam can drive</h1>
      <p>ryxnroam only uses documented developer tooling. It reports exactly what this computer supports and never pretends a device accepted a location.</p>
      <table className="matrix">
        <tbody>
          <tr>
            <td>iOS Simulator</td>
            <td>macOS with Xcode 14 or later</td>
          </tr>
          <tr>
            <td>iPhone & iPad</td>
            <td>pymobiledevice3 installed, Developer Mode on, device trusts this computer</td>
          </tr>
          <tr>
            <td>Android Emulator</td>
            <td>Android SDK platform-tools (adb)</td>
          </tr>
          <tr>
            <td>Physical Android</td>
            <td className="muted">Not supported — Android requires an on-device mock-location app</td>
          </tr>
        </tbody>
      </table>
      <div style={{ marginTop: 16, display: "grid", gap: 6 }}>
        <div className="menu-label" style={{ padding: "0 0 4px" }}>
          On this {platform === "darwin" ? "Mac" : "computer"}
        </div>
        {adapters.length === 0 && <span className="muted" style={{ fontSize: 12 }}>Checking tools…</span>}
        {adapters.map((a) => (
          <div key={a.adapterId} style={{ display: "flex", gap: 10, fontSize: 12, alignItems: "flex-start" }}>
            <StatusDot state={a.available ? "connected" : a.platformSupported ? "disconnected" : "unsupported"} className="" />
            <span>
              <b style={{ fontWeight: 600 }}>{a.label}</b> <span className="muted">— {a.available ? "ready" : a.detail}</span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function Connect() {
  const snap = useStore((s) => s.devices);
  const showTest = useStore((s) => s.settings.devices.showTestAdapter);
  const real = snap.devices.filter((d) => !d.isTest);
  const missing = snap.adapters.filter((a) => !a.available && a.platformSupported);
  return (
    <>
      <h1>Connect a test device</h1>
      <p>Boot a simulator, start an Android emulator, or plug in a device you own with Developer Mode enabled. It appears here automatically.</p>
      <div className="card" style={{ padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: real.length ? 6 : 0 }}>
          <strong style={{ fontSize: 12.5 }}>{real.length ? `${real.length} found` : snap.scanning ? "Looking…" : "Nothing connected yet"}</strong>
          <button className="soft" onClick={() => api.devices.refresh()} disabled={snap.scanning}>
            {snap.scanning ? <span className="spinner" /> : <RefreshCw />} Refresh
          </button>
        </div>
        {real.map((d) => (
          <div key={d.id} className="adapter-row" style={{ padding: "8px 0" }}>
            <StatusDot state={d.state} />
            <div>
              <strong>{d.name}</strong>
              <p className="muted" style={{ fontSize: 11.5 }}>
                {STATE_TEXT[d.state]} · {deviceSubtitle(d)}
              </p>
              {d.guidance && d.state !== "connected" && <p style={{ fontSize: 11.5 }}>{d.guidance}</p>}
            </div>
          </div>
        ))}
      </div>
      {missing.length > 0 && real.length === 0 && (
        <div className="notice" style={{ marginTop: 12 }}>
          <Smartphone />
          <span>
            {missing.map((a) => (
              <span key={a.adapterId} style={{ display: "block" }}>
                <b>{a.label}:</b> {a.guidance ?? a.detail}
              </span>
            ))}
          </span>
        </div>
      )}
      <div className="option" style={{ marginTop: 14, paddingTop: 0 }}>
        <span>
          <strong>No hardware right now?</strong>
          <small>Enable the loopback test adapter to try every control. It is labelled TEST and changes no real device.</small>
        </span>
        <Switch label="Enable test adapter" checked={showTest} onChange={(v) => updateSettings({ devices: { showTestAdapter: v } })} />
      </div>
    </>
  );
}

function Explore() {
  const mod = platform === "darwin" ? "⌘" : "Ctrl+";
  return (
    <>
      <h1>Finding your way around</h1>
      <p>Everything starts as a preview inside ryxnroam. A device only changes when you press Start.</p>
      <div className="onb-points">
        <Point icon={MousePointerClick} title="Click to choose" text="Click the map to drop a pin. Drag it to fine-tune." />
        <Point icon={Search} title={`Search with ${mod}K`} text="Places, addresses or coordinates like 48.8584, 2.2945." />
        <Point icon={Crosshair} title="Right-click for more" text="Save, copy coordinates or add a route stop." />
        <Point icon={Eye} title="Preview vs. simulate" text="Preview moves the map only. Start sends it to the device." />
      </div>
    </>
  );
}

function Ready() {
  return (
    <>
      <h1>Ready when you are.</h1>
      <p>A few promises ryxnroam keeps:</p>
      <div className="onb-points">
        <Point icon={ShieldCheck} title="Visible at all times" text="An active simulation always shows in the top bar and on the map." />
        <Point icon={Lock} title="Always stoppable" text="Stop restores the device location. Closing the app stops too." />
        <Point icon={Eye} title="Honest status" text="Success is only shown after the device tool confirms it." />
        <Point icon={Smartphone} title="Your devices only" text="Use it on devices and test environments you're authorized to control." />
      </div>
    </>
  );
}
