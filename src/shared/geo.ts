import type { LatLng, MovementMode, Units } from "./types";

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function isValidLatLng(p: unknown): p is LatLng {
  if (!p || typeof p !== "object") return false;
  const { lat, lng } = p as LatLng;
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** Great-circle distance in metres. */
export function haversine(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing in degrees (0 = north, clockwise). */
export function bearing(a: LatLng, b: LatLng): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Spherical interpolation between two points (t in 0..1). */
export function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  if (t <= 0) return { ...a };
  if (t >= 1) return { ...b };
  const φ1 = toRad(a.lat);
  const λ1 = toRad(a.lng);
  const φ2 = toRad(b.lat);
  const λ2 = toRad(b.lng);
  const δ = haversine(a, b) / EARTH_RADIUS_M;
  if (δ < 1e-12) return { ...a };
  const A = Math.sin((1 - t) * δ) / Math.sin(δ);
  const B = Math.sin(t * δ) / Math.sin(δ);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return {
    lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lng: toDeg(Math.atan2(y, x)),
  };
}

/** Pre-computed polyline for O(log n) position lookups by distance. */
export class Polyline {
  readonly points: LatLng[];
  readonly cumulative: number[];
  readonly length: number;

  constructor(points: LatLng[]) {
    const clean = points.filter(isValidLatLng);
    if (clean.length === 0) throw new Error("Polyline needs at least one point");
    this.points = clean;
    this.cumulative = [0];
    for (let i = 1; i < clean.length; i++) {
      this.cumulative.push(this.cumulative[i - 1] + haversine(clean[i - 1], clean[i]));
    }
    this.length = this.cumulative[this.cumulative.length - 1];
  }

  /** Position after travelling `meters` from the start (clamped). */
  at(meters: number): LatLng {
    if (this.points.length === 1 || meters <= 0) return { ...this.points[0] };
    if (meters >= this.length) return { ...this.points[this.points.length - 1] };
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] <= meters) lo = mid;
      else hi = mid;
    }
    const seg = this.cumulative[hi] - this.cumulative[lo];
    const t = seg === 0 ? 0 : (meters - this.cumulative[lo]) / seg;
    return interpolate(this.points[lo], this.points[hi], t);
  }

  /** Heading at a distance along the line. */
  headingAt(meters: number): number {
    if (this.points.length < 2) return 0;
    const m = Math.max(0, Math.min(this.length, meters));
    let i = this.cumulative.findIndex((c) => c > m);
    if (i <= 0) i = this.points.length - 1;
    return bearing(this.points[i - 1], this.points[i]);
  }

  /** The sub-polyline from `meters` to the end (used to resume playback). */
  sliceFrom(meters: number): LatLng[] {
    if (meters <= 0) return this.points.map((p) => ({ ...p }));
    const start = this.at(meters);
    const rest = this.points.filter((_, i) => this.cumulative[i] > meters);
    return [start, ...rest.map((p) => ({ ...p }))];
  }

  /** Split into [traveled, remaining] for map rendering. */
  split(meters: number): [LatLng[], LatLng[]] {
    const at = this.at(meters);
    const before = this.points.filter((_, i) => this.cumulative[i] < meters);
    const after = this.points.filter((_, i) => this.cumulative[i] > meters);
    return [
      [...before, at],
      [at, ...after],
    ];
  }
}

/** Straight segments densified every ~`stepMeters` so interpolation follows the great circle. */
export function directPath(stops: LatLng[], stepMeters = 250): LatLng[] {
  if (stops.length === 0) return [];
  const out: LatLng[] = [{ ...stops[0] }];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    const d = haversine(a, b);
    const n = Math.max(1, Math.ceil(d / stepMeters));
    for (let k = 1; k <= n; k++) out.push(interpolate(a, b, k / n));
  }
  return out;
}

export const MODE_SPEED_KMH: Record<Exclude<MovementMode, "custom">, number> = {
  walk: 5,
  cycle: 16,
  drive: 50,
};

export const MIN_SPEED_KMH = 1;
export const MAX_SPEED_KMH = 300;

export function speedKmh(mode: MovementMode, customKmh: number): number {
  if (mode === "custom") return clampSpeed(customKmh);
  return MODE_SPEED_KMH[mode];
}

export function clampSpeed(kmh: number): number {
  if (!Number.isFinite(kmh)) return MODE_SPEED_KMH.walk;
  return Math.min(MAX_SPEED_KMH, Math.max(MIN_SPEED_KMH, kmh));
}

export const kmhToMps = (kmh: number) => kmh / 3.6;
export const mpsToKmh = (mps: number) => mps * 3.6;

export function formatDistance(meters: number, units: Units): string {
  if (!Number.isFinite(meters)) return "—";
  if (units === "imperial") {
    const feet = meters * 3.28084;
    if (feet < 1000) return `${Math.round(feet)} ft`;
    const miles = meters / 1609.344;
    return `${miles < 10 ? miles.toFixed(2) : miles.toFixed(1)} mi`;
  }
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(2) : km.toFixed(1)} km`;
}

export function formatSpeed(kmh: number, units: Units): string {
  if (units === "imperial") return `${(kmh / 1.609344).toFixed(kmh < 16 ? 1 : 0)} mph`;
  return `${kmh.toFixed(kmh < 10 ? 1 : 0)} km/h`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${m.toString().padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${s.toString().padStart(2, "0")} s`;
  return `${s} s`;
}
