import type { LatLng } from "./types";
import { Polyline } from "./geo";

const esc = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/**
 * Build a timed GPX track that moves along `points` at `speedMps`, emitting a
 * point every `stepSeconds`. Used by adapters whose tool replays GPX files.
 */
export function buildTimedGpx(
  points: LatLng[],
  speedMps: number,
  startAt: Date,
  name = "ryxnroam route",
  stepSeconds = 1,
): string {
  const line = new Polyline(points);
  const totalS = speedMps > 0 ? line.length / speedMps : 0;
  const steps = Math.max(1, Math.ceil(totalS / stepSeconds));
  const trkpts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const s = Math.min(totalS, i * stepSeconds);
    const p = line.at(s * speedMps);
    const t = new Date(startAt.getTime() + s * 1000).toISOString();
    trkpts.push(
      `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}"><time>${t}</time></trkpt>`,
    );
  }
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="ryxnroam" xmlns="http://www.topografix.com/GPX/1/1">`,
    `  <trk><name>${esc(name)}</name><trkseg>`,
    ...trkpts,
    `  </trkseg></trk>`,
    `</gpx>`,
    "",
  ].join("\n");
}

/** Waypoint-only GPX for exporting saved routes. */
export function buildRouteGpx(name: string, geometry: LatLng[]): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="ryxnroam" xmlns="http://www.topografix.com/GPX/1/1">`,
    `  <trk><name>${esc(name)}</name><trkseg>`,
    ...geometry.map((p) => `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}"/>`),
    `  </trkseg></trk>`,
    `</gpx>`,
    "",
  ].join("\n");
}
