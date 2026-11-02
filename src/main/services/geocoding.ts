import { PHOTON_LANGS } from "../../shared/defaults";
import type { GeocodeResult, LatLng } from "../../shared/types";
import { RateGate, TtlCache, getJson } from "./http";

/**
 * Search uses two OpenStreetMap-based services, each within its usage policy:
 *  - Photon (komoot) for search-as-you-type suggestions (designed for it).
 *  - Nominatim for explicit searches (Enter) and reverse geocoding, max 1 req/s,
 *    never for autocomplete, with an identifying User-Agent. Results are cached.
 */

const PHOTON = "https://photon.komoot.io";
const NOMINATIM = "https://nominatim.openstreetmap.org";
const nominatimGate = new RateGate(1100);
const searchCache = new TtlCache<GeocodeResult[]>(200, 30 * 60_000);
const reverseCache = new TtlCache<GeocodeResult | null>(500, 24 * 60 * 60_000);

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    osm_id?: number;
    osm_type?: string;
    osm_value?: string;
    name?: string;
    housenumber?: string;
    street?: string;
    city?: string;
    district?: string;
    state?: string;
    country?: string;
    postcode?: string;
    extent?: [number, number, number, number];
  };
}

function photonToResult(f: PhotonFeature): GeocodeResult {
  const p = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  const street = [p.street, p.housenumber].filter(Boolean).join(" ");
  const name = p.name || street || p.city || p.state || p.country || "Unnamed place";
  const detail = [p.name ? street : "", p.district, p.city, p.state, p.country]
    .filter((x, i, a) => x && x !== name && a.indexOf(x) === i)
    .join(", ");
  return {
    id: `photon:${p.osm_type ?? ""}${p.osm_id ?? `${lat},${lng}`}`,
    name,
    detail,
    point: { lat, lng },
    kind: p.osm_value,
    // Photon extent is [minLon, maxLat, maxLon, minLat]
    bbox: p.extent ? [p.extent[0], p.extent[3], p.extent[2], p.extent[1]] : undefined,
  };
}

interface NominatimItem {
  place_id: number;
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
  type?: string;
  boundingbox?: [string, string, string, string];
}

function nominatimToResult(n: NominatimItem): GeocodeResult {
  const parts = n.display_name.split(", ");
  const name = n.name || parts[0];
  return {
    id: `nominatim:${n.place_id}`,
    name,
    detail: parts.filter((p) => p !== name).slice(0, 4).join(", "),
    point: { lat: Number(n.lat), lng: Number(n.lon) },
    kind: n.type,
    bbox: n.boundingbox
      ? [Number(n.boundingbox[2]), Number(n.boundingbox[0]), Number(n.boundingbox[3]), Number(n.boundingbox[1])]
      : undefined,
  };
}

export async function search(
  query: string,
  opts: { bias?: LatLng; submit?: boolean; lang: string; signal?: AbortSignal },
): Promise<GeocodeResult[]> {
  const q = query.trim().slice(0, 200);
  if (q.length < 2) return [];
  const lang = opts.lang === "local" ? "" : opts.lang;
  const key = `${opts.submit ? "n" : "p"}|${lang}|${q.toLowerCase()}|${opts.bias ? `${opts.bias.lat.toFixed(1)},${opts.bias.lng.toFixed(1)}` : ""}`;
  const cached = searchCache.get(key);
  if (cached) return cached;

  let results: GeocodeResult[];
  if (opts.submit) {
    await nominatimGate.wait();
    const url = new URL(`${NOMINATIM}/search`);
    url.searchParams.set("q", q);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "8");
    if (lang) url.searchParams.set("accept-language", lang);
    const items = await getJson<NominatimItem[]>(url.toString(), { signal: opts.signal, lang: lang || undefined });
    results = items.map(nominatimToResult);
  } else {
    const url = new URL(`${PHOTON}/api/`);
    url.searchParams.set("q", q);
    url.searchParams.set("limit", "8");
    if (lang && PHOTON_LANGS.has(lang)) url.searchParams.set("lang", lang);
    if (opts.bias) {
      url.searchParams.set("lat", opts.bias.lat.toFixed(4));
      url.searchParams.set("lon", opts.bias.lng.toFixed(4));
    }
    const data = await getJson<{ features: PhotonFeature[] }>(url.toString(), { signal: opts.signal });
    results = (data.features ?? []).map(photonToResult);
  }
  const unique = results.filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i);
  searchCache.set(key, unique);
  return unique;
}

export async function reverse(point: LatLng, lang: string, signal?: AbortSignal): Promise<GeocodeResult | null> {
  const l = lang === "local" ? "" : lang;
  const key = `${l}|${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
  const cached = reverseCache.get(key);
  if (cached !== undefined) return cached;
  await nominatimGate.wait();
  const url = new URL(`${NOMINATIM}/reverse`);
  url.searchParams.set("lat", point.lat.toFixed(6));
  url.searchParams.set("lon", point.lng.toFixed(6));
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("zoom", "18");
  if (l) url.searchParams.set("accept-language", l);
  const item = await getJson<NominatimItem & { error?: string }>(url.toString(), { signal, lang: l || undefined });
  const result = item?.error || !item?.display_name ? null : { ...nominatimToResult(item), point };
  reverseCache.set(key, result);
  return result;
}
