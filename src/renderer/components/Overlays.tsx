import { AlertTriangle, CheckCircle2, Info, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { formatLatLng } from "../../shared/coords";
import { api } from "../api";
import { dismissToast, stopSimulation, useStore } from "../store";
import { BrandEmblem, Modal, NavGlyph, StatusDot } from "./primitives";

/** Always-visible banner while anything is simulated, so it can never run unnoticed. */
export function SimBanner() {
  const sim = useStore((s) => s.sim);
  const fmt = useStore((s) => s.settings.location.coordFormat);
  const pos = sim.appliedPosition ?? sim.enginePosition;
  if (sim.phase === "idle") return null;
  if (sim.phase === "failed")
    return (
      <div className="sim-banner glass failed" role="alert" data-testid="sim-banner">
        <StatusDot state="failed" />
        <span className="text" title={sim.error?.detail}>
          <b>Simulation failed</b> — {sim.error?.message}
          {sim.error?.detail ? <span className="muted"> {sim.error.detail}</span> : null}
        </span>
        <button className="stop" onClick={() => api.simulation.dismissError()}>
          <X /> Dismiss
        </button>
      </div>
    );
  return (
    <div className="sim-banner on" role="status" aria-live="polite" data-testid="sim-banner">
      <StatusDot live={sim.phase === "active"} />
      <span className="text">
        <b>
          {sim.phase === "starting"
            ? "Connecting to"
            : sim.phase === "stopping"
              ? "Restoring"
              : sim.phase === "paused"
                ? "Paused on"
                : sim.isTest
                  ? "Test simulation on"
                  : "Simulating on"}{" "}
          {sim.deviceName}
        </b>
        {pos && sim.phase !== "starting" && <span className="num"> · {formatLatLng(pos, fmt)}</span>}
      </span>
      {sim.isTest && <span className="badge inverse">Test</span>}
      <button className="stop" onClick={() => void stopSimulation()} disabled={sim.phase === "stopping"} data-testid="banner-stop">
        <Square /> {sim.phase === "starting" ? "Cancel" : "Stop"}
      </button>
    </div>
  );
}

/** Toasts sit just above the control panel; while a dialog is open they float over it instead. */
export function Toasts({ placement }: { placement: "stage" | "overlay" }) {
  const toasts = useStore((s) => s.toasts);
  const dialogOpen = useStore(
    (s) => !!(s.settingsOpen || s.onboardingOpen || s.favoriteEditor || s.scheduleEditor || s.routeNamer || s.confirm || s.introVisible),
  );
  if ((placement === "overlay") !== dialogOpen) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""} ${t.leaving ? "leaving" : ""}`} role={t.kind === "error" ? "alert" : "status"}>
          {t.kind === "error" ? <AlertTriangle /> : t.kind === "success" ? <CheckCircle2 /> : <Info />}
          <span className="grow">{t.text}</span>
          <button aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const req = useStore((s) => s.confirm);
  const [checked, setChecked] = useState(false);
  useEffect(() => setChecked(false), [req]);
  if (!req) return null;
  const finish = (ok: boolean) => {
    req.resolve({ ok, checked });
    useStore.setState({ confirm: null });
  };
  return (
    <Modal onClose={() => finish(false)} className="small" label={req.title}>
      <div className="dialog-heading">
        <h1 style={{ fontSize: 18, paddingRight: 30 }}>{req.title}</h1>
        <p style={{ marginBottom: 0 }}>{req.body}</p>
      </div>
      {req.checkbox && (
        <label className="check" style={{ marginTop: 16, fontSize: 12 }}>
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {req.checkbox}
        </label>
      )}
      <div className="dialog-actions">
        <button className="secondary" onClick={() => finish(false)}>
          Cancel
        </button>
        <button className={`primary ${req.danger ? "danger" : ""}`} onClick={() => finish(true)} data-autofocus data-testid="confirm-ok">
          {req.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/** Opening reveal, adapted from ryxnontop's IntroSplash. Never blocks longer than the user wants. */
export function IntroSplash({ light, square, onDone }: { light: boolean; square: boolean; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  const name = "ryxnroam";
  const leave = () => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(onDone, 420);
  };
  useEffect(() => {
    const t = setTimeout(leave, 3200);
    const key = (e: KeyboardEvent) => (e.key === "Enter" || e.key === "Escape" || e.key === " ") && leave();
    window.addEventListener("keydown", key);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", key);
    };
  });
  return (
    <main className={`intro ${light ? "light" : ""} ${square ? "square" : ""} ${leaving ? "leaving" : ""}`} role="dialog" aria-label="ryxnroam" data-testid="intro">
      <div className="intro-orb" aria-hidden="true" />
      <div className="intro-top">
        <span>MADE BY RYAN J.</span>
        <button title="Quit" aria-label="Quit app" onClick={() => api.app.window("close")}>
          <X />
        </button>
      </div>
      <div className="intro-stage">
        <span className="intro-icon" aria-hidden="true">
          r<NavGlyph />
        </span>
        <h1 aria-label={name}>
          {[...name].map((l, i) => (
            <span key={i} aria-hidden="true" style={{ animationDelay: `${200 + i * 42}ms` }}>
              {l}
            </span>
          ))}
          <span className="intro-dot" aria-hidden="true" style={{ animationDelay: "650ms" }}>
            .
          </span>
        </h1>
        <p>Location simulation studio.</p>
        <div className="intro-rule" aria-hidden="true" />
      </div>
      <button className="intro-enter" onClick={leave} data-testid="intro-enter">
        Open studio <span aria-hidden="true">↗</span>
      </button>
    </main>
  );
}

export function BridgeMissing() {
  return (
    <div className="app" style={{ display: "grid", placeItems: "center" }}>
      <div className="empty">
        <BrandEmblem />
        <h3 style={{ marginTop: 14 }}>ryxnroam must run inside its desktop app</h3>
        <p>This page needs the app's secure bridge to reach devices and storage.</p>
      </div>
    </div>
  );
}
