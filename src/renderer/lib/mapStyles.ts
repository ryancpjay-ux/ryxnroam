import type { StyleSpecification } from "maplibre-gl";
import type { MapStyleId } from "../../shared/types";

/** OpenFreeMap: free, keyless vector tiles built from OpenStreetMap data. */
const BASE = "https://tiles.openfreemap.org/styles";

export const MAP_STYLES: { id: Exclude<MapStyleId, "auto">; label: string; url: string; swatch: string }[] = [
  { id: "dark", label: "Dark", url: `${BASE}/dark`, swatch: "linear-gradient(135deg,#1b1b1b,#2e2e2e 60%,#3a3a3a)" },
  { id: "light", label: "Light", url: `${BASE}/positron`, swatch: "linear-gradient(135deg,#f2f2f2,#e0e0e0 60%,#d2d6da)" },
  { id: "streets", label: "Streets", url: `${BASE}/liberty`, swatch: "linear-gradient(135deg,#f3eee4,#cfe3c1 55%,#a9cbe8)" },
  { id: "bright", label: "Bright", url: `${BASE}/bright`, swatch: "linear-gradient(135deg,#f8f4ec,#ffe39b 55%,#9fd1f5)" },
];

export function resolveStyle(id: MapStyleId, dark: boolean) {
  const effective = id === "auto" ? (dark ? "dark" : "light") : id;
  return MAP_STYLES.find((s) => s.id === effective) ?? MAP_STYLES[0];
}

const styleCache = new Map<string, Promise<StyleSpecification>>();

function fetchStyle(name: string): Promise<StyleSpecification> {
  let p = styleCache.get(name);
  if (!p) {
    p = fetch(`${BASE}/${name}`)
      .then((r) => {
        if (!r.ok) throw new Error(`map style unavailable (HTTP ${r.status})`);
        return r.json() as Promise<StyleSpecification>;
      })
      .catch((e) => {
        styleCache.delete(name);
        throw e;
      });
    styleCache.set(name, p);
  }
  return p;
}

/** The style to hand MapLibre: a URL for styles used as published, or a style built here. */
export async function buildStyle(id: Exclude<MapStyleId, "auto">): Promise<string | StyleSpecification> {
  if (id === "dark" || id === "light") return withPlaceLabels(id);
  return MAP_STYLES.find((m) => m.id === id)!.url;
}

/**
 * OpenFreeMap's Dark and Positron styles only name cities, roads and water. Add
 * Liberty's point-of-interest labels (campuses, parks, stations, shops…) with
 * colours that suit each theme, below the town names so those stay on top.
 */
async function withPlaceLabels(id: "dark" | "light"): Promise<StyleSpecification> {
  const dark = id === "dark";
  const [base, liberty] = await Promise.all([fetchStyle(dark ? "dark" : "positron"), fetchStyle("liberty")]);
  // Layer ids must be unique: skip anything the base already has (Positron has its own `airport`).
  const existing = new Set(base.layers.map((l) => l.id));
  const pois = liberty.layers
    .filter((l) => l.type === "symbol" && /^(poi|airport)/.test(l.id) && !existing.has(l.id))
    .map((l) => ({
      ...l,
      paint: {
        ...("paint" in l ? l.paint : {}),
        "text-color": dark ? "#d4d4d4" : "#404040",
        "text-halo-color": dark ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.92)",
        "text-halo-width": 1.2,
      },
    })) as StyleSpecification["layers"];
  const towns = base.layers.findIndex((l) => l.type === "symbol" && "source-layer" in l && l["source-layer"] === "place");
  const at = towns < 0 ? base.layers.length : towns;
  return { ...base, layers: [...base.layers.slice(0, at), ...pois, ...base.layers.slice(at)] };
}
