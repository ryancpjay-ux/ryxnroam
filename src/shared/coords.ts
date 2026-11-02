import type { CoordFormat, LatLng } from "./types";
import { isValidLatLng } from "./geo";

/**
 * Parse free-form coordinate input. Accepts:
 *   "40.6892, -74.0445"   "40.6892 -74.0445"   "40.6892;-74.0445"
 *   "40°41'21.1\"N 74°02'40.2\"W"   "N 40.6892 W 74.0445"
 * Returns null when the text is not a coordinate pair.
 */
export function parseCoordinates(input: string): LatLng | null {
  const text = input.trim();
  if (!text) return null;

  const decimal = text.match(
    /^\s*([NS])?\s*(-?\d{1,2}(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*([EW])?\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])?\s*$/i,
  );
  if (decimal) {
    let lat = Number(decimal[2]);
    let lng = Number(decimal[5]);
    const ns = (decimal[1] || decimal[3] || "").toUpperCase();
    const ew = (decimal[4] || decimal[6] || "").toUpperCase();
    if (ns === "S") lat = -Math.abs(lat);
    if (ew === "W") lng = -Math.abs(lng);
    const p = { lat, lng };
    return isValidLatLng(p) ? p : null;
  }

  const dmsPart =
    /(\d{1,3})\s*°\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*["″]\s*)?([NSEW])/gi;
  const parts = [...text.matchAll(dmsPart)];
  if (parts.length === 2) {
    const values = parts.map((m) => {
      const deg = Number(m[1]) + Number(m[2] ?? 0) / 60 + Number(m[3] ?? 0) / 3600;
      const hemi = m[4].toUpperCase();
      return { hemi, value: hemi === "S" || hemi === "W" ? -deg : deg };
    });
    const latPart = values.find((v) => v.hemi === "N" || v.hemi === "S");
    const lngPart = values.find((v) => v.hemi === "E" || v.hemi === "W");
    if (!latPart || !lngPart) return null;
    const p = { lat: latPart.value, lng: lngPart.value };
    return isValidLatLng(p) ? p : null;
  }
  return null;
}

function toDms(value: number, pos: string, neg: string): string {
  const hemi = value >= 0 ? pos : neg;
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let min = Math.floor((abs - deg) * 60);
  let sec = Math.round(((abs - deg) * 60 - min) * 60 * 10) / 10;
  if (sec >= 60) {
    sec = 0;
    min += 1;
  }
  if (min >= 60) {
    min = 0;
    deg += 1;
  }
  return `${deg}°${min.toString().padStart(2, "0")}′${sec.toFixed(1).padStart(4, "0")}″${hemi}`;
}

export function formatLat(lat: number, format: CoordFormat): string {
  return format === "dms" ? toDms(lat, "N", "S") : lat.toFixed(6);
}

export function formatLng(lng: number, format: CoordFormat): string {
  return format === "dms" ? toDms(lng, "E", "W") : lng.toFixed(6);
}

export function formatLatLng(p: LatLng, format: CoordFormat): string {
  return `${formatLat(p.lat, format)}, ${formatLng(p.lng, format)}`;
}
