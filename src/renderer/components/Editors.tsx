import { CalendarClock, Route as RouteIcon, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { formatLatLng } from "../../shared/coords";
import type { Schedule } from "../../shared/types";
import { api } from "../api";
import { setRoute, toast, useStore } from "../store";
import { Modal, SelectMenu, useModalClose } from "./primitives";

export function FavoriteEditor() {
  const ed = useStore((s) => s.favoriteEditor);
  if (!ed) return null;
  return (
    <Modal onClose={() => useStore.setState({ favoriteEditor: null })} label={ed.id ? "Edit saved location" : "Save location"}>
      <FavoriteForm />
    </Modal>
  );
}

function FavoriteForm() {
  const ed = useStore((s) => s.favoriteEditor)!;
  const fmt = useStore((s) => s.settings.location.coordFormat);
  const favorites = useStore((s) => s.library.favorites);
  const groups = useMemo(() => [...new Set(favorites.map((f) => f.group).filter(Boolean))] as string[], [favorites]);
  const close = useModalClose();
  const [name, setName] = useState(ed.name);
  const [group, setGroup] = useState(ed.group ?? "");
  const [note, setNote] = useState(ed.note ?? "");
  const save = async () => {
    if (!name.trim()) return;
    try {
      const fav = await api.library.saveFavorite({
        id: ed.id,
        name: name.trim(),
        point: ed.point,
        address: ed.address,
        group: group.trim() || undefined,
        note: note.trim() || undefined,
      });
      const sel = useStore.getState().selection;
      if (sel && sel.point.lat === fav.point.lat && sel.point.lng === fav.point.lng)
        useStore.setState({ selection: { ...sel, name: fav.name, favoriteId: fav.id } });
      toast(ed.id ? "Saved location updated." : `Saved “${fav.name}”.`, "success");
      close();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="dialog-heading">
        <Star />
        <h1>{ed.id ? "Edit saved location" : "Save this location"}</h1>
        <p className="num">{ed.address ? `${ed.address} · ` : ""}{formatLatLng(ed.point, fmt)}</p>
      </div>
      <div className="form">
        <label>
          Name
          <input className="field" data-autofocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Test store, Office lobby" data-testid="favorite-name" />
        </label>
        <label>
          <span>Group <span className="faint">(optional)</span></span>
          <input className="field" value={group} maxLength={60} list="fav-groups" onChange={(e) => setGroup(e.target.value)} placeholder="e.g. QA cities" />
          <datalist id="fav-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
        <label>
          <span>Note <span className="faint">(optional)</span></span>
          <textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!name.trim()} data-testid="favorite-save">
          Save
        </button>
      </div>
    </form>
  );
}

export function RouteNamer() {
  const open = useStore((s) => s.routeNamer);
  if (!open) return null;
  return (
    <Modal onClose={() => useStore.setState({ routeNamer: false })} className="small" label="Save route">
      <RouteNameForm />
    </Modal>
  );
}

function RouteNameForm() {
  const route = useStore((s) => s.route);
  const close = useModalClose();
  const [name, setName] = useState(route.name ?? (route.stops.length ? `${route.stops[0].name ?? "Start"} → ${route.stops[route.stops.length - 1].name ?? "Destination"}` : "Route"));
  const save = async () => {
    try {
      const saved = await api.library.saveRoute({
        id: route.savedId ?? undefined,
        name: name.trim(),
        stops: route.stops,
        mode: route.mode,
        customSpeedKmh: route.customKmh,
        pathMode: route.pathMode,
        loop: route.loop,
        geometry: route.computed?.geometry,
        distanceMeters: route.computed?.distanceMeters,
      });
      setRoute({ name: saved.name, savedId: saved.id });
      toast(`Route “${saved.name}” saved.`, "success");
      close();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) void save();
      }}
    >
      <div className="dialog-heading">
        <RouteIcon />
        <h1 style={{ fontSize: 18 }}>Save route</h1>
        <p>
          {route.stops.length} stops · saved with its movement mode{route.loop ? " and loop setting" : ""}.
        </p>
      </div>
      <div className="form">
        <label>
          Name
          <input className="field" data-autofocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} data-testid="route-name" />
        </label>
      </div>
      <div className="dialog-actions">
        <button type="button" className="secondary" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!name.trim()} data-testid="route-save">
          Save route
        </button>
      </div>
    </form>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function ScheduleEditor() {
  const ed = useStore((s) => s.scheduleEditor);
  if (!ed) return null;
  return (
    <Modal onClose={() => useStore.setState({ scheduleEditor: null })} label="New schedule">
      <ScheduleForm initial={ed.target} />
    </Modal>
  );
}

function ScheduleForm({ initial }: { initial?: Schedule["target"] }) {
  const lib = useStore((s) => s.library);
  const devices = useStore((s) => s.devices.devices);
  const selectedDeviceId = useStore((s) => s.selectedDeviceId);
  const close = useModalClose();
  const targets = useMemo(
    () => [
      ...lib.favorites.map((f) => ({ value: `favorite:${f.id}`, label: `★ ${f.name}` })),
      ...lib.routes.map((r) => ({ value: `route:${r.id}`, label: `⟿ ${r.name}` })),
    ],
    [lib],
  );
  const [target, setTarget] = useState(initial ? (initial.kind === "favorite" ? `favorite:${initial.favoriteId}` : `route:${initial.routeId}`) : targets[0]?.value ?? "");
  const usable = devices.filter((d) => d.state === "connected");
  const [deviceId, setDeviceId] = useState(usable.find((d) => d.id === selectedDeviceId)?.id ?? usable[0]?.id ?? "");
  const [startAt, setStartAt] = useState(() => localInput(new Date(Date.now() + 10 * 60_000)));
  const [duration, setDuration] = useState<string>("");
  const [consent, setConsent] = useState(false);
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [error, setError] = useState<string | null>(null);

  const startMs = new Date(startAt).getTime();
  const durationN = duration ? Number(duration) : null;
  const device = devices.find((d) => d.id === deviceId);
  const targetLabel = targets.find((t) => t.value === target)?.label.slice(2) ?? "";
  const valid =
    !!target &&
    !!device &&
    Number.isFinite(startMs) &&
    startMs > Date.now() &&
    (durationN === null || (Number.isInteger(durationN) && durationN >= 1 && durationN <= 1440));

  const create = async () => {
    const [kind, id] = target.split(":");
    const res = await api.schedules.create({
      target: kind === "favorite" ? { kind: "favorite", favoriteId: id } : { kind: "route", routeId: id },
      deviceId,
      startAt: startMs,
      durationMinutes: durationN,
      consent: true,
    });
    if (res.ok) {
      toast(`Scheduled for ${new Date(startMs).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`, "success");
      useStore.setState({ section: "schedule" });
      close();
    } else {
      setError(res.error);
      setStep("edit");
    }
  };

  if (step === "review")
    return (
      <>
        <div className="dialog-heading">
          <CalendarClock />
          <h1>Review schedule</h1>
          <p>ryxnroam must be open and the device connected at the start time. If either isn't true, the schedule is marked as missed or failed — never completed.</p>
        </div>
        <dl className="review" data-testid="schedule-review">
          <dt>Target</dt>
          <dd>{targetLabel}</dd>
          <dt>Device</dt>
          <dd>
            {device?.name}
            {device?.isTest ? " (test adapter)" : ""}
          </dd>
          <dt>Starts</dt>
          <dd>{new Date(startMs).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}</dd>
          <dt>Duration</dt>
          <dd>{durationN ? `${durationN} minutes, then the location is restored` : "Until you stop it"}</dd>
        </dl>
        <div className="dialog-actions">
          <button className="secondary" onClick={() => setStep("edit")}>
            Back
          </button>
          <button className="primary" onClick={() => void create()} data-testid="schedule-create">
            Schedule
          </button>
        </div>
      </>
    );

  return (
    <>
      <div className="dialog-heading">
        <CalendarClock />
        <h1>Schedule a simulation</h1>
        <p>Start a saved location or route automatically at a set time.</p>
      </div>
      {targets.length === 0 ? (
        <p className="muted">Save a location or route first.</p>
      ) : (
        <div className="form">
          <div className="label">
            Location or route
            <SelectMenu label="Location or route" value={target} options={targets} onChange={setTarget} />
          </div>
          <div className="label">
            Device
            {usable.length ? (
              <SelectMenu
                label="Device"
                value={deviceId}
                options={usable.map((d) => ({ value: d.id, label: `${d.name}${d.isTest ? " (test)" : ""}` }))}
                onChange={setDeviceId}
              />
            ) : (
              <span className="notice warn">No connected device. Connect one to schedule a simulation.</span>
            )}
          </div>
          <div className="form-row">
            <label>
              Start
              <input className="field" type="datetime-local" value={startAt} min={localInput(new Date())} onChange={(e) => setStartAt(e.target.value)} data-testid="schedule-start" />
            </label>
            <label>
              <span>Duration in minutes <span className="faint">(optional)</span></span>
              <input className="field" type="number" min={1} max={1440} placeholder="Until stopped" value={duration} onChange={(e) => setDuration(e.target.value)} />
            </label>
          </div>
          <label className="consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="schedule-consent" />
            <span>
              I am authorized to simulate this device's location, and I understand the simulation will start automatically at this time and stay visible in ryxnroam
              until it ends.
            </span>
          </label>
          {error && <div className="notice bad">{error}</div>}
        </div>
      )}
      <div className="dialog-actions">
        <button className="secondary" onClick={close}>
          Cancel
        </button>
        <button className="primary" disabled={!valid || !consent} onClick={() => setStep("review")} data-testid="schedule-review-button">
          Review
        </button>
      </div>
    </>
  );
}
