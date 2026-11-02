import { AttributionControl, LngLatBounds, Map as MLMap, Marker, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "maplibre-gl/dist/maplibre-gl.css";
import { Copy, Crosshair, Layers, LocateFixed, MapPin, Minus, Plus, Route as RouteIcon, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatLatLng } from "../../shared/coords";
import { Polyline } from "../../shared/geo";
import type { LatLng, MapStyleId } from "../../shared/types";
import { api } from "../api";
import { MAP_STYLES, buildStyle, resolveStyle } from "../lib/mapStyles";
import { addStop, fitPoints, flyTo, moveStop, selectPoint, toast, useStore, zoomBy } from "../store";

// MapLibre resolves its worker relative to its own module, which bundling breaks; point it at the emitted file.
setWorkerUrl(workerUrl);

const VIEW_KEY = "ryxnroam.mapView";
/** The map starts empty; the style effect applies the real (possibly runtime-built) style. */
const BLANK_STYLE: StyleSpecification = { version: 8, name: "ryxnroam-blank", sources: {}, layers: [] };
const ROUTE_SRC = "roam-route";
const DONE_SRC = "roam-route-done";

function loadView(): { center: [number, number]; zoom: number } {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "");
    if (Array.isArray(v.center) && typeof v.zoom === "number") return v;
  } catch {
    /* storage may be unavailable */
  }
  return { center: [-30, 30], zoom: 1.7 };
}

const lineFeature = (pts: LatLng[]) => ({
  type: "Feature" as const,
  properties: {},
  geometry: { type: "LineString" as const, coordinates: pts.map((p) => [p.lng, p.lat]) },
});
const EMPTY_FC = { type: "FeatureCollection" as const, features: [] };

/**
 * MapLibre positions a marker by writing `transform` on its root element, so
 * every animated or restyled part lives on an inner element instead.
 */
function markerRoot(inner: HTMLElement) {
  const root = document.createElement("div");
  root.appendChild(inner);
  root.addEventListener("click", (e) => e.stopPropagation());
  return root;
}

function pinElement() {
  const pin = document.createElement("div");
  pin.className = "pin";
  pin.innerHTML = `<svg viewBox="0 0 30 40" aria-hidden="true"><path d="M15 39c-.6 0-1-.3-1.4-.8C8 30.8 2 23.2 2 15A13 13 0 0 1 28 15c0 8.2-6 15.8-11.6 23.2-.4.5-.8.8-1.4.8z" fill="#fff" stroke="#000" stroke-width="2"/><circle cx="15" cy="15" r="5" fill="#000"/></svg>`;
  return markerRoot(pin);
}

export function MapView({ dark }: { dark: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [styleTick, setStyleTick] = useState(0);
  const [ctx, setCtx] = useState<{ x: number; y: number; point: LatLng } | null>(null);
  const [styleMenu, setStyleMenu] = useState(false);

  const styleSetting = useStore((s) => s.mapStyleOverride ?? s.settings.general.defaultMapStyle);
  const style = resolveStyle(styleSetting, dark);
  const lang = useStore((s) => s.settings.general.placeLanguage);
  const darkMap = style.id === "dark";
  const mode = useStore((s) => s.mode);
  const selection = useStore((s) => s.selection);
  const route = useStore((s) => s.route);
  const sim = useStore((s) => s.sim);
  const favorites = useStore((s) => s.library.favorites);
  const command = useStore((s) => s.mapCommand);
  const fmt = useStore((s) => s.settings.location.coordFormat);

  // ---------------------------------------------------------------- create
  useEffect(() => {
    if (!container.current) return;
    const view = loadView();
    let map: MLMap;
    try {
      map = new MLMap({
        container: container.current,
        style: BLANK_STYLE,
        center: view.center,
        zoom: view.zoom,
        attributionControl: false,
        fadeDuration: 180,
        dragRotate: false,
        pitchWithRotate: false,
        maxPitch: 0,
      });
    } catch (e) {
      setFailed(`The map could not start: ${(e as Error).message}`);
      return;
    }
    map.touchZoomRotate.disableRotation();
    // Top-left keeps the required attribution clear of the floating control panel.
    map.addControl(new AttributionControl({ compact: true }), "top-left");
    mapRef.current = map;
    map.on("style.load", () => {
      if (map.getStyle().name === BLANK_STYLE.name) return;
      setLoaded(true);
      setStyleTick((t) => t + 1);
    });
    map.on("error", (e) => {
      const msg = String((e as unknown as { error?: { message?: string } }).error?.message ?? "");
      if (!map.isStyleLoaded() && /fetch|network|Failed|style/i.test(msg)) setFailed("Map tiles couldn't load. Check your internet connection.");
    });
    const saveView = () => {
      const c = map.getCenter();
      useStore.setState({ mapCenter: { lat: c.lat, lng: c.lng } });
      try {
        localStorage.setItem(VIEW_KEY, JSON.stringify({ center: [c.lng, c.lat], zoom: map.getZoom() }));
      } catch {
        /* ignore */
      }
    };
    map.on("moveend", saveView);
    saveView();
    map.on("click", (e) => {
      setCtx(null);
      setStyleMenu(false);
      const p = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      if (useStore.getState().mode === "route") addStop(p);
      else selectPoint(p, { source: "map" });
    });
    map.on("contextmenu", (e) => {
      e.preventDefault();
      setCtx({ x: e.point.x, y: e.point.y, point: { lat: e.lngLat.lat, lng: e.lngLat.lng } });
    });
    map.on("movestart", () => setCtx(null));
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // The map instance is created once; style changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----------------------------------------------------------- style/lang
  // A language change also reloads the style so "local" restores the original labels.
  const styleKey = `${style.id}|${lang}`;
  const appliedStyle = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || appliedStyle.current === styleKey) return;
    appliedStyle.current = styleKey;
    let cancelled = false;
    let applied = false;
    void (async () => {
      let next: string | StyleSpecification;
      try {
        next = await buildStyle(style.id);
      } catch (e) {
        // Building failed (offline or a style changed upstream): fall back to the published style.
        console.warn(`Couldn't add place labels to the map style: ${(e as Error).message}`);
        next = style.url;
      }
      if (cancelled) return;
      applied = true;
      if (typeof next !== "string") {
        // A style built here that MapLibre rejects must not leave the old map frozen in place.
        const fallback = style.url;
        const onError = (e: unknown) => {
          if (map.isStyleLoaded()) return;
          map.off("error", onError);
          console.warn(`Built map style was rejected; using the published style instead: ${String((e as { error?: { message?: string } }).error?.message ?? e)}`);
          map.setStyle(fallback, { diff: false });
        };
        map.on("error", onError);
        map.once("style.load", () => map.off("error", onError));
      }
      map.setStyle(next, { diff: false });
    })();
    return () => {
      cancelled = true;
      // Not applied yet (e.g. a quick remount): let the next run apply it.
      if (!applied && appliedStyle.current === styleKey) appliedStyle.current = null;
    };
    // style.url and style.id are captured by styleKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleTick) return;
    // Route layers (re-added after every style swap).
    const ink = darkMap ? "#ffffff" : "#000000";
    const casing = darkMap ? "#000000" : "#ffffff";
    if (!map.getSource(ROUTE_SRC)) map.addSource(ROUTE_SRC, { type: "geojson", data: EMPTY_FC });
    if (!map.getSource(DONE_SRC)) map.addSource(DONE_SRC, { type: "geojson", data: EMPTY_FC });
    const layout = { "line-cap": "round" as const, "line-join": "round" as const };
    if (!map.getLayer("roam-route-casing"))
      map.addLayer({ id: "roam-route-casing", type: "line", source: ROUTE_SRC, layout, paint: { "line-color": casing, "line-width": 8, "line-opacity": 0.85 } });
    if (!map.getLayer("roam-route-line"))
      map.addLayer({ id: "roam-route-line", type: "line", source: ROUTE_SRC, layout, paint: { "line-color": ink, "line-width": 4 } });
    if (!map.getLayer("roam-route-done"))
      map.addLayer({
        id: "roam-route-done",
        type: "line",
        source: DONE_SRC,
        layout,
        paint: { "line-color": ink, "line-width": 4, "line-opacity": 0.35, "line-dasharray": [1, 1.6] },
      });
    // Place-name language.
    if (lang !== "local") {
      for (const layer of map.getStyle().layers ?? []) {
        if (layer.type !== "symbol") continue;
        const tf = map.getLayoutProperty(layer.id, "text-field");
        if (tf && JSON.stringify(tf).includes("name"))
          map.setLayoutProperty(layer.id, "text-field", ["coalesce", ["get", `name:${lang}`], ["get", "name:latin"], ["get", "name"]]);
      }
    }
    setRouteData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleTick]);

  // ---------------------------------------------------------------- route
  const routeGeometry = sim.kind === "route" && sim.route ? sim.route.geometry : route.computed?.geometry ?? null;
  const traveled = sim.kind === "route" && sim.route ? sim.route.traveledMeters : 0;
  const polyline = useRef<{ key: LatLng[] | null; line: Polyline | null }>({ key: null, line: null });

  const setRouteData = () => {
    const map = mapRef.current;
    const src = map?.getSource(ROUTE_SRC) as GeoJSONSource | undefined;
    const done = map?.getSource(DONE_SRC) as GeoJSONSource | undefined;
    if (!src || !done) return;
    if (!routeGeometry || routeGeometry.length < 2) {
      src.setData(EMPTY_FC);
      done.setData(EMPTY_FC);
      return;
    }
    if (polyline.current.key !== routeGeometry) polyline.current = { key: routeGeometry, line: new Polyline(routeGeometry) };
    const line = polyline.current.line!;
    if (traveled > 0) {
      const [a, b] = line.split(traveled);
      done.setData(lineFeature(a));
      src.setData(lineFeature(b));
    } else {
      done.setData(EMPTY_FC);
      src.setData(lineFeature(routeGeometry));
    }
  };
  useEffect(setRouteData, [routeGeometry, traveled, styleTick]);

  // ------------------------------------------------------- selection marker
  const selMarker = useRef<Marker | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const show = mode === "location" && selection;
    if (!show) {
      selMarker.current?.remove();
      selMarker.current = null;
      return;
    }
    const lngLat: [number, number] = [selection.point.lng, selection.point.lat];
    if (!selMarker.current) {
      const m = new Marker({ element: pinElement(), anchor: "bottom", draggable: true }).setLngLat(lngLat).addTo(map);
      m.on("dragend", () => {
        const p = m.getLngLat();
        selectPoint({ lat: p.lat, lng: p.lng }, { source: "map" });
      });
      selMarker.current = m;
    } else selMarker.current.setLngLat(lngLat);
  }, [mode, selection]);

  // ----------------------------------------------------------- stop markers
  const stopMarkers = useRef(new Map<string, Marker>());
  const stops = sim.kind === "route" && sim.route && sim.phase !== "idle" ? sim.route.stops : mode === "route" ? route.stops : [];
  const editable = !(sim.kind === "route" && sim.phase !== "idle" && sim.phase !== "failed");
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    stops.forEach((s, i) => {
      seen.add(s.id);
      const label = i === 0 ? "A" : i === stops.length - 1 ? "B" : String(i);
      const end = i === stops.length - 1 && stops.length > 1;
      let m = stopMarkers.current.get(s.id);
      if (!m) {
        const created = new Marker({ element: markerRoot(document.createElement("div")), draggable: editable }).setLngLat([s.point.lng, s.point.lat]).addTo(map);
        const id = s.id;
        created.on("dragend", () => {
          const p = created.getLngLat();
          moveStop(id, { lat: p.lat, lng: p.lng });
        });
        stopMarkers.current.set(s.id, created);
        m = created;
      }
      m.setLngLat([s.point.lng, s.point.lat]);
      m.setDraggable(editable);
      const el = m.getElement().firstElementChild as HTMLElement;
      el.className = `stop-marker ${end ? "end" : ""}`;
      el.textContent = label;
      el.title = s.name ?? formatLatLng(s.point, fmt);
    });
    for (const [id, m] of stopMarkers.current) {
      if (!seen.has(id)) {
        m.remove();
        stopMarkers.current.delete(id);
      }
    }
  }, [stops, editable, fmt]);

  // ------------------------------------------------------- favorite markers
  const favMarkers = useRef(new Map<string, Marker>());
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const ids = new Set(favorites.map((f) => f.id));
    for (const [id, m] of favMarkers.current) {
      if (!ids.has(id)) {
        m.remove();
        favMarkers.current.delete(id);
      }
    }
    for (const f of favorites) {
      let m = favMarkers.current.get(f.id);
      if (!m) {
        const el = document.createElement("button");
        el.className = "fav-marker";
        el.addEventListener("click", () => {
          const fav = useStore.getState().library.favorites.find((x) => x.id === f.id);
          if (!fav) return;
          if (useStore.getState().mode === "route") addStop(fav.point, fav.name);
          else selectPoint(fav.point, { source: "favorite", name: fav.name, detail: fav.address, favoriteId: fav.id });
        });
        const created = new Marker({ element: markerRoot(el) }).setLngLat([f.point.lng, f.point.lat]).addTo(map);
        favMarkers.current.set(f.id, created);
        m = created;
      }
      m.setLngLat([f.point.lng, f.point.lat]);
      const btn = m.getElement().firstElementChild as HTMLElement;
      btn.title = `${f.name} (saved)`;
      btn.setAttribute("aria-label", `Saved location ${f.name}`);
    }
  }, [favorites]);

  // --------------------------------------------------------- device marker
  const devMarker = useRef<Marker | null>(null);
  const anim = useRef<{ from: LatLng; to: LatLng; start: number; dur: number; raf: number } | null>(null);
  const devicePos = sim.phase === "idle" || sim.phase === "failed" ? null : sim.confirmation === "playback" || !sim.appliedPosition ? sim.enginePosition : sim.appliedPosition;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!devicePos) {
      devMarker.current?.remove();
      devMarker.current = null;
      return;
    }
    const cls = `device-marker ${sim.isTest ? "test" : ""} ${sim.confirmation === "playback" || sim.phase === "starting" ? "unconfirmed" : ""}`;
    let marker = devMarker.current;
    if (!marker) {
      const inner = document.createElement("div");
      inner.innerHTML = `<span class="halo"></span><span class="core"></span>`;
      marker = new Marker({ element: markerRoot(inner) }).setLngLat([devicePos.lng, devicePos.lat]).addTo(map);
      devMarker.current = marker;
    }
    const el = marker.getElement().firstElementChild as HTMLElement;
    el.className = cls;
    el.title =
      sim.phase === "starting"
        ? "Waiting for the device to confirm"
        : sim.confirmation === "playback"
          ? "Estimated position — the device is replaying the route"
          : sim.isTest
            ? "Test adapter position (no real device)"
            : `Confirmed on ${sim.deviceName}`;
    const cur = marker.getLngLat();
    const from = { lat: cur.lat, lng: cur.lng };
    if (anim.current) cancelAnimationFrame(anim.current.raf);
    const dur = sim.kind === "route" ? 950 : 600;
    const start = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      const e = sim.kind === "route" ? k : 1 - Math.pow(1 - k, 3);
      devMarker.current?.setLngLat([from.lng + (devicePos.lng - from.lng) * e, from.lat + (devicePos.lat - from.lat) * e]);
      if (k < 1 && anim.current) anim.current.raf = requestAnimationFrame(step);
    };
    anim.current = { from, to: devicePos, start, dur, raf: requestAnimationFrame(step) };
  }, [devicePos?.lat, devicePos?.lng, sim.isTest, sim.confirmation, sim.phase]);

  // -------------------------------------------------------------- commands
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !command) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (command.kind === "fly")
      map.flyTo({ center: [command.point.lng, command.point.lat], zoom: command.zoom ?? Math.max(map.getZoom(), 14), duration: reduce ? 0 : 1400, essential: true });
    else if (command.kind === "fit")
      map.fitBounds([[command.bbox[0], command.bbox[1]], [command.bbox[2], command.bbox[3]]], { padding: 80, maxZoom: 16, duration: reduce ? 0 : 1200 });
    else if (command.kind === "fitPoints") {
      const b = new LngLatBounds();
      for (const p of command.points) b.extend([p.lng, p.lat]);
      map.fitBounds(b, { padding: { top: 90, bottom: 260, left: 70, right: 90 }, maxZoom: 16, duration: reduce ? 0 : 1200 });
    } else if (command.kind === "zoom") map.easeTo({ zoom: map.getZoom() + command.delta, duration: reduce ? 0 : 280 });
  }, [command]);

  const locate = () => {
    const target = devicePos ?? selection?.point;
    if (target) flyTo(target, 16);
    else if (routeGeometry) fitPoints(routeGeometry);
    else toast("Nothing to show yet — select a location or start a simulation.");
  };

  const setStyle = (id: MapStyleId) => {
    useStore.setState({ mapStyleOverride: id });
    setStyleMenu(false);
  };

  return (
    <>
      <div ref={container} className="map" data-testid="map" aria-label="Interactive map" />
      <div className={`map-loading ${loaded ? "done" : ""}`} aria-hidden={loaded}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }} className="muted">
          <span className="spinner" /> Loading map
        </div>
      </div>
      {failed && (
        <div className="map-error">
          <div className="empty">
            <div className="empty-mark">
              <MapPin />
            </div>
            <h3>Map unavailable</h3>
            <p>{failed}</p>
            <button className="soft" style={{ marginTop: 14 }} onClick={() => window.location.reload()}>
              Try again
            </button>
          </div>
        </div>
      )}

      <div className="map-tools">
        <div className="tool-group glass">
          <button className="tool" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1)}>
            <Plus />
          </button>
          <button className="tool" title="Zoom out" aria-label="Zoom out" onClick={() => zoomBy(-1)}>
            <Minus />
          </button>
        </div>
        <div className="tool-group glass">
          <button className="tool" title="Show current position" aria-label="Show current position" onClick={locate}>
            <LocateFixed />
          </button>
          <button
            className="tool"
            title="Map style"
            aria-label="Map style"
            aria-expanded={styleMenu}
            data-testid="style-button"
            onClick={() => setStyleMenu((o) => !o)}
          >
            <Layers />
          </button>
        </div>
        {styleMenu && (
          <div className="popover style-menu" role="menu" style={{ top: 90 }}>
            <div className="menu-label">Map style</div>
            {[{ id: "auto" as const, label: "Auto (follows theme)", swatch: dark ? MAP_STYLES[0].swatch : MAP_STYLES[1].swatch }, ...MAP_STYLES].map((s) => (
              <button key={s.id} className="style-option" role="menuitemradio" aria-checked={styleSetting === s.id} onClick={() => setStyle(s.id)}>
                <span className="style-swatch" style={{ background: s.swatch }} />
                <span style={{ flex: 1 }}>{s.label}</span>
                {styleSetting === s.id && <span className="badge">On</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {ctx && (
        <div className="popover ctx-menu" role="menu" style={{ left: ctx.x, top: ctx.y }} onContextMenu={(e) => e.preventDefault()}>
          <div className="menu-label num" style={{ textTransform: "none", letterSpacing: 0 }}>
            {formatLatLng(ctx.point, fmt)}
          </div>
          <button
            className="menu-item"
            onClick={() => {
              useStore.setState({ mode: "location" });
              selectPoint(ctx.point, { source: "map" });
              setCtx(null);
            }}
          >
            <Crosshair size={14} /> Select this location
          </button>
          <button
            className="menu-item"
            onClick={() => {
              useStore.setState({ mode: "route" });
              addStop(ctx.point);
              setCtx(null);
            }}
          >
            <RouteIcon size={14} /> Add as route stop
          </button>
          <button
            className="menu-item"
            onClick={() => {
              useStore.setState({ favoriteEditor: { name: "", point: ctx.point } });
              setCtx(null);
            }}
          >
            <Star size={14} /> Save location…
          </button>
          <button
            className="menu-item"
            onClick={async () => {
              await api.diagnostics.copy(`${ctx.point.lat.toFixed(6)}, ${ctx.point.lng.toFixed(6)}`);
              toast("Coordinates copied.");
              setCtx(null);
            }}
          >
            <Copy size={14} /> Copy coordinates
          </button>
        </div>
      )}
    </>
  );
}
