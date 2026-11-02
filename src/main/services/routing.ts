import { directPath, haversine } from "../../shared/geo";
import type { ComputedRoute, LatLng, MovementMode, PathMode } from "../../shared/types";
import { RateGate, TtlCache, getJson } from "./http";

/**
 * Road routing through the FOSSGIS OSRM servers that power openstreetmap.org
 * (light use, identifying User-Agent, ≤ 1 req/s). If routing fails, we fall
 * back to straight segments and say so in `fallbackReason`.
 */
const BASE = "https://routing.openstreetmap.de";
const PROFILE: Record<MovementMode, string> = {
  walk: "routed-foot",
  cycle: "routed-bike",
  drive: "routed-car",
  custom: "routed-car",
};
const gate = new RateGate(1000);
const cache = new TtlCache<ComputedRoute>(100, 60 * 60_000);

export function directRoute(stops: LatLng[], fallbackReason?: string): ComputedRoute {
  const geometry = directPath(stops);
  let distance = 0;
  for (let i = 1; i < stops.length; i++) distance += haversine(stops[i - 1], stops[i]);
  return { geometry, distanceMeters: distance, providerDurationS: null, provider: "direct", fallbackReason };
}

export async function computeRoute(
  stops: LatLng[],
  mode: MovementMode,
  pathMode: PathMode,
  signal?: AbortSignal,
): Promise<ComputedRoute> {
  if (stops.length < 2) throw new Error("Add at least a start and a destination.");
  if (pathMode === "direct") return directRoute(stops);
  const coords = stops.map((s) => `${s.lng.toFixed(6)},${s.lat.toFixed(6)}`).join(";");
  const key = `${mode}|${coords}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    await gate.wait();
    const url = `${BASE}/${PROFILE[mode]}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
    const data = await getJson<{
      code: string;
      message?: string;
      routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[];
    }>(url, { signal, timeoutMs: 15000 });
    const r = data.routes?.[0];
    if (data.code !== "Ok" || !r) throw new Error(data.message || `Routing returned ${data.code}`);
    const result: ComputedRoute = {
      geometry: r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      distanceMeters: r.distance,
      providerDurationS: r.duration,
      provider: "osrm",
    };
    cache.set(key, result);
    return result;
  } catch (e) {
    if (signal?.aborted) throw e;
    return directRoute(stops, `Road routing unavailable (${(e as Error).message}); using straight lines.`);
  }
}
