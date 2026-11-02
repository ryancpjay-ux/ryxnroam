import { Crosshair, MapPin, Search, Star, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { formatLatLng, parseCoordinates } from "../../shared/coords";
import type { GeocodeResult } from "../../shared/types";
import { api, platform } from "../api";
import { addStop, fitBounds, selectPoint, useStore } from "../store";
import { Skeleton } from "./primitives";

type Row =
  | { kind: "coords"; point: { lat: number; lng: number } }
  | { kind: "favorite"; id: string; name: string; detail: string; point: { lat: number; lng: number } }
  | { kind: "place"; r: GeocodeResult };

export interface SearchHandle {
  focus(): void;
}

export const SearchBox = forwardRef<SearchHandle>(function SearchBox(_props, ref) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [hl, setHl] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const favorites = useStore((s) => s.library.favorites);
  const fmt = useStore((s) => s.settings.location.coordFormat);
  const mode = useStore((s) => s.mode);
  const seq = useRef(0);

  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }));

  const coords = parseCoordinates(q);
  const favMatches = q.trim().length >= 1 && !coords
    ? favorites.filter((f) => f.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 3)
    : [];
  const rows: Row[] = [
    ...(coords ? [{ kind: "coords" as const, point: coords }] : []),
    ...favMatches.map((f) => ({ kind: "favorite" as const, id: f.id, name: f.name, detail: f.address ?? formatLatLng(f.point, fmt), point: f.point })),
    ...(coords ? [] : results.map((r) => ({ kind: "place" as const, r }))),
  ];

  const run = async (text: string, submit: boolean) => {
    const id = ++seq.current;
    if (text.trim().length < 3 || parseCoordinates(text)) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const bias = useStore.getState().mapCenter ?? undefined;
    const r = await api.geo.search(text, { bias, submit });
    if (id !== seq.current) return;
    setLoading(false);
    setSubmitted(submit);
    if (r.ok) {
      setResults(r.value);
      setHl(0);
    } else if (r.code !== "cancelled") setError(r.error);
  };

  useEffect(() => {
    const t = setTimeout(() => void run(q, false), 380);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const choose = (row: Row) => {
    setOpen(false);
    input.current?.blur();
    const asStop = mode === "route";
    if (row.kind === "coords") {
      if (asStop) addStop(row.point);
      else selectPoint(row.point, { source: "coords" }, { fly: true, zoom: 15 });
      return;
    }
    if (row.kind === "favorite") {
      if (asStop) addStop(row.point, row.name);
      else selectPoint(row.point, { source: "favorite", name: row.name, detail: row.detail, favoriteId: row.id }, { fly: true, zoom: 15 });
      return;
    }
    const r = row.r;
    if (asStop) addStop(r.point, r.name);
    else selectPoint(r.point, { source: "search", name: r.name, detail: r.detail }, { fly: !r.bbox, zoom: 15 });
    if (r.bbox && !asStop) fitBounds(r.bbox);
  };

  const showPanel = open && q.trim().length > 0;

  return (
    <div className="search" ref={root}>
      <label className="search-field">
        <Search />
        <input
          ref={input}
          value={q}
          placeholder={mode === "route" ? "Add a stop" : "Search or paste coordinates"}
          aria-label="Search places or coordinates"
          data-testid="search-input"
          onChange={(e) => {
            const text = e.target.value;
            setQ(text);
            setOpen(true);
            // Never leave the previous query's results clickable while the new ones load,
            // and drop any response still in flight for it.
            seq.current++;
            setResults([]);
            setSubmitted(false);
            setError(null);
            setHl(0);
            setLoading(text.trim().length >= 3 && !parseCoordinates(text));
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHl((h) => Math.min(rows.length - 1, h + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHl((h) => Math.max(0, h - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (rows[hl] && (submitted || coords || hl > 0 || results.length)) choose(rows[hl]);
              else void run(q, true);
            } else if (e.key === "Escape") {
              if (q) setQ("");
              else input.current?.blur();
              setOpen(false);
            }
          }}
        />
        {q ? (
          <button className="icon-btn sm" aria-label="Clear search" onClick={() => (setQ(""), input.current?.focus())}>
            <X />
          </button>
        ) : (
          <span className="kbd">{platform === "darwin" ? "⌘K" : "Ctrl K"}</span>
        )}
      </label>
      {showPanel && (
        <div className="popover search-results" role="listbox" aria-label="Search results" data-testid="search-results">
          {rows.map((row, i) => {
            const key = row.kind === "place" ? row.r.id : row.kind === "favorite" ? `f${row.id}` : "coords";
            return (
              <button
                key={key}
                role="option"
                aria-selected={hl === i}
                className={`result ${hl === i ? "highlighted" : ""}`}
                onMouseEnter={() => setHl(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(row)}
              >
                {row.kind === "coords" ? <Crosshair /> : row.kind === "favorite" ? <Star /> : <MapPin />}
                <span>
                  <strong>{row.kind === "coords" ? "Go to coordinates" : row.kind === "favorite" ? row.name : row.r.name}</strong>
                  <small className="num">
                    {row.kind === "coords" ? formatLatLng(row.point, fmt) : row.kind === "favorite" ? `Saved · ${row.detail}` : row.r.detail || formatLatLng(row.r.point, fmt)}
                  </small>
                </span>
              </button>
            );
          })}
          {loading &&
            rows.length < 2 &&
            [0, 1, 2].map((i) => (
              <div className="skeleton-row" key={i}>
                <Skeleton w={15} h={15} />
                <span style={{ flex: 1, display: "grid", gap: 6 }}>
                  <Skeleton w={`${70 - i * 12}%`} h={10} />
                  <Skeleton w={`${45 + i * 8}%`} h={8} />
                </span>
              </div>
            ))}
          {!loading && error && <div className="search-foot">Search is unavailable right now: {error}</div>}
          {!loading && !error && rows.length === 0 && q.trim().length >= 3 && (
            <div className="search-foot">No places found. Press Enter for a deeper search.</div>
          )}
          {!loading && !error && q.trim().length > 0 && q.trim().length < 3 && rows.length === 0 && (
            <div className="search-foot">Keep typing…</div>
          )}
          <div className="search-foot">
            {submitted ? "Results from Nominatim" : "Suggestions from Photon · Enter for Nominatim"} · © OpenStreetMap contributors
          </div>
        </div>
      )}
    </div>
  );
});
