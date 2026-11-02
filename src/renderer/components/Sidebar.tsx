import {
  CalendarClock,
  CircleSlash,
  Clock3,
  Download,
  History as HistoryIcon,
  MapPin,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Route as RouteIcon,
  Search,
  Settings,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { formatLatLng } from "../../shared/coords";
import { formatDistance } from "../../shared/geo";
import type { Schedule, SavedRoute } from "../../shared/types";
import { api } from "../api";
import {
  addStop,
  confirmAction,
  fitPoints,
  selectPoint,
  setRoute,
  toast,
  useStore,
  type Section,
} from "../store";
import { DeviceIcon, DeviceSelector } from "./DeviceSelector";
import { StatusDot } from "./primitives";
import { SearchBox, type SearchHandle } from "./SearchBox";

const SECTIONS: { id: Section; label: string; icon: typeof Star }[] = [
  { id: "saved", label: "Saved", icon: Star },
  { id: "routes", label: "Routes", icon: RouteIcon },
  { id: "schedule", label: "Plan", icon: CalendarClock },
  { id: "history", label: "History", icon: HistoryIcon },
];

export function Sidebar({ searchRef }: { searchRef: React.RefObject<SearchHandle | null> }) {
  const open = useStore((s) => s.sidebarOpen);
  const section = useStore((s) => s.section);
  const device = useStore((s) => s.devices.devices.find((d) => d.id === s.selectedDeviceId) ?? null);
  const simOn = useStore((s) => s.sim.phase === "active" || s.sim.phase === "paused");

  const openWith = (sec?: Section, focusSearch = false) => {
    useStore.setState({ sidebarOpen: true, ...(sec ? { section: sec } : {}) });
    if (focusSearch) setTimeout(() => searchRef.current?.focus(), 260);
  };

  return (
    <aside className={`sidebar ${open ? "" : "collapsed"}`} aria-label="Sidebar">
      <div className="rail" aria-hidden={open}>
        <button className="icon-btn" title={device?.name ?? "Devices"} onClick={() => openWith()} tabIndex={open ? -1 : 0}>
          <DeviceIcon device={device} />
        </button>
        <StatusDot state={device?.state ?? "disconnected"} live={simOn} />
        <div className="rail-sep" />
        <button className="icon-btn" title="Search" onClick={() => openWith(undefined, true)} tabIndex={open ? -1 : 0}>
          <Search />
        </button>
        {SECTIONS.map((s) => (
          <button key={s.id} className="icon-btn" title={s.label} onClick={() => openWith(s.id)} tabIndex={open ? -1 : 0}>
            <s.icon />
          </button>
        ))}
        <span className="spacer" />
        <button className="icon-btn" title="Settings" onClick={() => useStore.setState({ settingsOpen: "general" })} tabIndex={open ? -1 : 0}>
          <Settings />
        </button>
        <button className="icon-btn" title="Expand sidebar" aria-label="Expand sidebar" onClick={() => openWith()} tabIndex={open ? -1 : 0}>
          <PanelLeftOpen />
        </button>
      </div>

      <div className="sidebar-inner" aria-hidden={!open}>
        <div className="sidebar-top">
          <DeviceSelector />
          <SearchBox ref={searchRef} />
          <NowCard />
        </div>
        <div className="tabs" role="tablist" aria-label="Library">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={section === s.id}
              className="tab"
              data-testid={`tab-${s.id}`}
              onClick={() => useStore.setState({ section: s.id })}
            >
              <s.icon size={12} />
              {s.label}
            </button>
          ))}
        </div>
        <div className="section-body" key={section}>
          {section === "saved" && <SavedPanel />}
          {section === "routes" && <RoutesPanel />}
          {section === "schedule" && <SchedulePanel />}
          {section === "history" && <HistoryPanel />}
        </div>
        <div className="sidebar-foot">
          <button className="soft square" onClick={() => useStore.setState({ settingsOpen: "general" })}>
            <Settings /> Settings
          </button>
          <button className="icon-btn" title="Collapse sidebar" aria-label="Collapse sidebar" onClick={() => useStore.setState({ sidebarOpen: false })}>
            <PanelLeftClose />
          </button>
        </div>
      </div>
    </aside>
  );
}

function NowCard() {
  const sim = useStore((s) => s.sim);
  const fmt = useStore((s) => s.settings.location.coordFormat);
  const pos = sim.appliedPosition ?? sim.enginePosition;
  const on = sim.phase === "active" || sim.phase === "paused" || sim.phase === "starting" || sim.phase === "stopping";
  if (sim.phase === "failed")
    return (
      <div className="now-card failed" data-testid="now-card">
        <StatusDot state="failed" />
        <span className="grow">
          <strong>Simulation failed</strong>
          <small title={sim.error?.detail}>{sim.error?.message}</small>
        </span>
        <button className="icon-btn sm" title="Dismiss" aria-label="Dismiss" onClick={() => api.simulation.dismissError()}>
          <X />
        </button>
      </div>
    );
  if (!on)
    return (
      <div className="now-card" data-testid="now-card">
        <CircleSlash size={15} className="faint" />
        <span className="grow">
          <strong>Not simulating</strong>
          <small>{sim.note ?? "Devices report their own location."}</small>
        </span>
      </div>
    );
  return (
    <button
      className="now-card on"
      data-testid="now-card"
      style={{ width: "100%", textAlign: "left" }}
      onClick={() => pos && selectPoint(pos, { source: "device", name: sim.targetName ?? undefined }, { fly: true })}
      title="Show on map"
    >
      <StatusDot live={sim.phase === "active"} />
      <span className="grow">
        <strong>
          {sim.phase === "starting" ? "Connecting…" : sim.kind === "route" ? (sim.phase === "paused" ? "Route paused" : "Moving along route") : "Simulated location"}
          {sim.isTest && " · test"}
        </strong>
        <small className="num">
          {sim.deviceName}
          {pos ? ` · ${formatLatLng(pos, fmt)}` : ""}
        </small>
      </span>
    </button>
  );
}

function Empty({ icon: Icon, title, text }: { icon: typeof Star; title: string; text: string }) {
  return (
    <div className="empty">
      <div className="empty-mark">
        <Icon />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

function SavedPanel() {
  const favorites = useStore((s) => s.library.favorites);
  const fmt = useStore((s) => s.settings.location.coordFormat);
  const selection = useStore((s) => s.selection);
  const mode = useStore((s) => s.mode);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const groups = useMemo(() => [...new Set(favorites.map((f) => f.group).filter(Boolean))] as string[], [favorites]);
  const list = favorites
    .filter((f) => !group || f.group === group)
    .filter((f) => !q || `${f.name} ${f.address ?? ""} ${f.group ?? ""}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) =>
      sort === "name" ? a.name.localeCompare(b.name) : (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt),
    );

  return (
    <>
      <div className="section-head">
        <h2>
          Saved locations<small>{favorites.length}</small>
        </h2>
        <button className="text-btn" onClick={() => setSort((s) => (s === "recent" ? "name" : "recent"))} title="Change sort order">
          {sort === "recent" ? "Recent" : "A–Z"}
        </button>
      </div>
      {favorites.length > 0 && (
        <label className="mini-search">
          <Search />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter saved locations" aria-label="Filter saved locations" />
        </label>
      )}
      {groups.length > 0 && (
        <div className="chips">
          <button className="chip" aria-pressed={!group} onClick={() => setGroup(null)}>
            All
          </button>
          {groups.map((g) => (
            <button key={g} className="chip" aria-pressed={group === g} onClick={() => setGroup(group === g ? null : g)}>
              {g}
            </button>
          ))}
        </div>
      )}
      {favorites.length === 0 ? (
        <Empty icon={Star} title="No saved locations" text="Select a spot on the map and press the star to keep it here." />
      ) : list.length === 0 ? (
        <Empty icon={Search} title="Nothing matches" text="Try a different name or group." />
      ) : (
        <div className="list" data-testid="favorites-list">
          {list.map((f, i) => (
            <div
              key={f.id}
              role="button"
              tabIndex={0}
              className={`item ${selection?.favoriteId === f.id ? "selected" : ""}`}
              style={{ animationDelay: `${Math.min(i, 8) * 25}ms` }}
              onClick={() =>
                mode === "route"
                  ? addStop(f.point, f.name)
                  : selectPoint(f.point, { source: "favorite", name: f.name, detail: f.address, favoriteId: f.id }, { fly: true, zoom: 15 })
              }
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLElement).click()}
            >
              <span className="item-icon">
                <Star />
              </span>
              <span className="grow">
                <strong>{f.name}</strong>
                <small className="num">{f.group ? `${f.group} · ` : ""}{f.address ?? formatLatLng(f.point, fmt)}</small>
              </span>
              <span className="item-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon-btn sm"
                  title="Edit"
                  aria-label={`Edit ${f.name}`}
                  onClick={() => useStore.setState({ favoriteEditor: { id: f.id, name: f.name, point: f.point, address: f.address, group: f.group, note: f.note } })}
                >
                  <Pencil />
                </button>
                <button
                  className="icon-btn sm"
                  title="Delete"
                  aria-label={`Delete ${f.name}`}
                  onClick={async () => {
                    const r = await confirmAction({ title: `Delete “${f.name}”?`, body: "This saved location will be removed. Schedules that use it will fail.", confirmLabel: "Delete", danger: true });
                    if (r.ok) {
                      await api.library.deleteFavorite(f.id);
                      toast("Saved location deleted.");
                    }
                  }}
                >
                  <Trash2 />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function loadRoute(r: SavedRoute) {
  useStore.setState({ mode: "route" });
  setRoute(
    {
      stops: r.stops,
      mode: r.mode,
      customKmh: r.customSpeedKmh ?? useStore.getState().route.customKmh,
      pathMode: r.pathMode,
      loop: r.loop,
      name: r.name,
      savedId: r.id,
      computed: r.geometry ? { geometry: r.geometry, distanceMeters: r.distanceMeters ?? 0, providerDurationS: null, provider: r.pathMode === "direct" ? "direct" : "osrm" } : null,
    },
    !r.geometry,
  );
  fitPoints(r.geometry ?? r.stops.map((s) => s.point));
}

function RoutesPanel() {
  const routes = useStore((s) => s.library.routes);
  const units = useStore((s) => s.settings.location.units);
  const activeId = useStore((s) => s.route.savedId);
  const [q, setQ] = useState("");
  const list = routes.filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()));
  const modeLabel = { walk: "Walking", cycle: "Cycling", drive: "Driving", custom: "Custom" } as const;
  return (
    <>
      <div className="section-head">
        <h2>
          Saved routes<small>{routes.length}</small>
        </h2>
        <button className="text-btn" onClick={() => useStore.setState({ mode: "route" })}>
          New route
        </button>
      </div>
      {routes.length > 3 && (
        <label className="mini-search">
          <Search />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter routes" aria-label="Filter routes" />
        </label>
      )}
      {routes.length === 0 ? (
        <Empty icon={RouteIcon} title="No saved routes" text="Switch to Route mode, add stops on the map, then save the route." />
      ) : (
        <div className="list">
          {list.map((r, i) => (
            <div
              key={r.id}
              role="button"
              tabIndex={0}
              className={`item ${activeId === r.id ? "selected" : ""}`}
              style={{ animationDelay: `${Math.min(i, 8) * 25}ms` }}
              onClick={() => loadRoute(r)}
              onKeyDown={(e) => e.key === "Enter" && loadRoute(r)}
            >
              <span className="item-icon">
                <RouteIcon />
              </span>
              <span className="grow">
                <strong>{r.name}</strong>
                <small>
                  {r.stops.length} stops · {modeLabel[r.mode]}
                  {r.distanceMeters ? ` · ${formatDistance(r.distanceMeters, units)}` : ""}
                  {r.loop ? " · loop" : ""}
                </small>
              </span>
              <span className="item-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon-btn sm"
                  title="Export GPX"
                  aria-label={`Export ${r.name} as GPX`}
                  onClick={async () => {
                    const res = await api.library.exportRouteGpx(r.id);
                    if (res.ok) toast("Route exported as GPX.", "success");
                    else if (res.code !== "cancelled") toast(res.error, "error");
                  }}
                >
                  <Download />
                </button>
                <button
                  className="icon-btn sm"
                  title="Delete"
                  aria-label={`Delete ${r.name}`}
                  onClick={async () => {
                    const c = await confirmAction({ title: `Delete “${r.name}”?`, body: "This saved route will be removed. Schedules that use it will fail.", confirmLabel: "Delete", danger: true });
                    if (c.ok) {
                      await api.library.deleteRoute(r.id);
                      toast("Route deleted.");
                    }
                  }}
                >
                  <Trash2 />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const SCHEDULE_TEXT: Record<Schedule["status"], string> = {
  scheduled: "Scheduled",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  missed: "Missed",
  cancelled: "Cancelled",
};

function SchedulePanel() {
  const schedules = useStore((s) => s.schedules);
  const lib = useStore((s) => s.library);
  const canSchedule = lib.favorites.length + lib.routes.length > 0;
  const upcoming = schedules.filter((s) => s.status === "scheduled" || s.status === "running").sort((a, b) => a.startAt - b.startAt);
  const past = schedules.filter((s) => s.status !== "scheduled" && s.status !== "running");
  const dotFor = (s: Schedule) =>
    s.status === "running" ? "connected" : s.status === "completed" ? "connected" : s.status === "scheduled" ? "connecting" : s.status === "failed" ? "failed" : "disconnected";
  const row = (s: Schedule) => (
    <div className="item" key={s.id} title={s.outcomeDetail} data-testid="schedule-item">
      <span className="item-icon">
        <Clock3 />
      </span>
      <span className="grow">
        <strong>{s.targetLabel}</strong>
        <small>
          {new Date(s.startAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          {s.durationMinutes ? ` · ${s.durationMinutes} min` : ""} · {s.deviceName}
        </small>
        <small style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--ink)" }}>
          <StatusDot state={dotFor(s) as never} live={s.status === "running"} /> {SCHEDULE_TEXT[s.status]}
          {s.outcomeDetail && s.status !== "scheduled" ? <span className="muted"> — {s.outcomeDetail}</span> : null}
        </small>
      </span>
      <span className="item-actions">
        {s.status === "scheduled" || s.status === "running" ? (
          <button className="icon-btn sm" title="Cancel schedule" aria-label="Cancel schedule" onClick={() => api.schedules.cancel(s.id)}>
            <X />
          </button>
        ) : (
          <button className="icon-btn sm" title="Remove" aria-label="Remove schedule" onClick={() => api.schedules.remove(s.id)}>
            <Trash2 />
          </button>
        )}
      </span>
    </div>
  );
  return (
    <>
      <div className="section-head">
        <h2>
          Scheduled<small>{upcoming.length}</small>
        </h2>
        <button className="text-btn" disabled={!canSchedule} onClick={() => useStore.setState({ scheduleEditor: {} })} data-testid="new-schedule">
          New schedule
        </button>
      </div>
      {!canSchedule && <Empty icon={CalendarClock} title="Nothing to schedule yet" text="Save a location or a route first, then plan when it should run." />}
      {canSchedule && schedules.length === 0 && (
        <Empty icon={CalendarClock} title="No schedules" text="Start a saved location or route at a set time. ryxnroam must be open when it starts." />
      )}
      <div className="list">{upcoming.map(row)}</div>
      {past.length > 0 && (
        <>
          <div className="section-head" style={{ marginTop: 16 }}>
            <h2>Past</h2>
          </div>
          <div className="list">{past.slice(0, 30).map(row)}</div>
        </>
      )}
    </>
  );
}

function HistoryPanel() {
  const history = useStore((s) => s.history);
  const units = useStore((s) => s.settings.location.units);
  return (
    <>
      <div className="section-head">
        <h2>
          History<small>{history.length}</small>
        </h2>
        {history.length > 0 && (
          <button
            className="text-btn"
            onClick={async () => {
              const r = await confirmAction({ title: "Clear history?", body: "All past simulation records are removed from this computer.", confirmLabel: "Clear history", danger: true });
              if (r.ok) {
                await api.history.clear();
                toast("History cleared.");
              }
            }}
          >
            Clear
          </button>
        )}
      </div>
      {history.length === 0 ? (
        <Empty icon={HistoryIcon} title="No history yet" text="Simulations you run are listed here. History stays on this computer." />
      ) : (
        <div className="list">
          {history.slice(0, 200).map((h, i) => (
            <div
              key={h.id}
              role="button"
              tabIndex={0}
              className="item"
              style={{ animationDelay: `${Math.min(i, 8) * 25}ms` }}
              onClick={() => selectPoint(h.point, { source: "history", name: h.label }, { fly: true, zoom: 15 })}
              onKeyDown={(e) => e.key === "Enter" && selectPoint(h.point, { source: "history", name: h.label }, { fly: true })}
              title={h.error}
            >
              <span className="item-icon">{h.kind === "route" ? <RouteIcon /> : <MapPin />}</span>
              <span className="grow">
                <strong>
                  {h.label} {h.isTest && <span className="badge">Test</span>}
                </strong>
                <small>
                  {new Date(h.startedAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })} · {h.deviceName}
                  {h.distanceMeters ? ` · ${formatDistance(h.distanceMeters, units)}` : ""}
                </small>
                <small style={{ color: h.outcome === "failed" ? "var(--bad)" : undefined }}>
                  {h.outcome === "running" ? "Running now" : h.outcome === "completed" ? "Completed" : h.outcome === "failed" ? `Failed${h.error ? ` — ${h.error}` : ""}` : "Stopped"}
                  {h.endedAt && h.outcome !== "running" ? ` · ${Math.max(1, Math.round((h.endedAt - h.startedAt) / 60000))} min` : ""}
                </small>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function useSearchRef() {
  return useRef<SearchHandle | null>(null);
}
