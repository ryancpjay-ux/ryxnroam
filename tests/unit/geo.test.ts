import { describe, expect, it } from "vitest";
import { formatLatLng, parseCoordinates } from "../../src/shared/coords";
import {
  Polyline,
  bearing,
  clampSpeed,
  directPath,
  formatDistance,
  formatDuration,
  haversine,
  interpolate,
  isValidLatLng,
  speedKmh,
} from "../../src/shared/geo";
import { buildTimedGpx } from "../../src/shared/gpx";

const paris = { lat: 48.8566, lng: 2.3522 };
const london = { lat: 51.5074, lng: -0.1278 };

describe("geo math", () => {
  it("measures great-circle distance", () => {
    expect(haversine(paris, london) / 1000).toBeCloseTo(343.5, 0);
    expect(haversine(paris, paris)).toBe(0);
  });

  it("computes bearing", () => {
    expect(bearing({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(0, 5);
    expect(bearing({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(90, 5);
  });

  it("interpolates along the great circle", () => {
    const mid = interpolate(paris, london, 0.5);
    expect(haversine(paris, mid)).toBeCloseTo(haversine(mid, london), 0);
    expect(interpolate(paris, london, 0)).toEqual(paris);
    expect(interpolate(paris, london, 1)).toEqual(london);
  });

  it("validates coordinates", () => {
    expect(isValidLatLng({ lat: 91, lng: 0 })).toBe(false);
    expect(isValidLatLng({ lat: 0, lng: -181 })).toBe(false);
    expect(isValidLatLng({ lat: Number.NaN, lng: 0 })).toBe(false);
    expect(isValidLatLng({ lat: -90, lng: 180 })).toBe(true);
  });

  it("finds positions by distance along a polyline", () => {
    const line = new Polyline([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.01 },
      { lat: 0.01, lng: 0.01 },
    ]);
    const leg = haversine({ lat: 0, lng: 0 }, { lat: 0, lng: 0.01 });
    expect(line.length).toBeCloseTo(leg * 2, -1);
    expect(line.at(0)).toEqual({ lat: 0, lng: 0 });
    expect(line.at(leg / 2).lng).toBeCloseTo(0.005, 6);
    expect(line.at(leg * 1.5).lat).toBeCloseTo(0.005, 4);
    expect(line.at(1e9)).toEqual({ lat: 0.01, lng: 0.01 });
    expect(line.headingAt(leg / 2)).toBeCloseTo(90, 1);
  });

  it("slices and splits a polyline for resume and rendering", () => {
    const line = new Polyline([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 0.02 },
    ]);
    const rest = new Polyline(line.sliceFrom(line.length / 2));
    expect(rest.length).toBeCloseTo(line.length / 2, -1);
    const [done, todo] = line.split(line.length / 4);
    expect(done.at(-1)).toEqual(todo[0]);
  });

  it("densifies straight routes", () => {
    const pts = directPath([paris, london], 10_000);
    expect(pts.length).toBeGreaterThan(30);
    expect(pts[0]).toEqual(paris);
    expect(haversine(pts.at(-1)!, london)).toBeLessThan(1);
  });

  it("maps movement modes to speeds and clamps custom speed", () => {
    expect(speedKmh("walk", 0)).toBe(5);
    expect(speedKmh("cycle", 0)).toBe(16);
    expect(speedKmh("drive", 0)).toBe(50);
    expect(speedKmh("custom", 999)).toBe(300);
    expect(clampSpeed(0)).toBe(1);
  });

  it("formats distances and durations", () => {
    expect(formatDistance(950, "metric")).toBe("950 m");
    expect(formatDistance(12_345, "metric")).toBe("12.3 km");
    expect(formatDistance(100, "imperial")).toBe("328 ft");
    expect(formatDistance(1609.344 * 3, "imperial")).toBe("3.00 mi");
    expect(formatDuration(65_000)).toBe("1 min 05 s");
    expect(formatDuration(3_725_000)).toBe("1 h 02 min");
  });
});

describe("coordinate parsing", () => {
  it.each([
    ["40.6892, -74.0445", { lat: 40.6892, lng: -74.0445 }],
    ["40.6892 -74.0445", { lat: 40.6892, lng: -74.0445 }],
    ["40.6892;-74.0445", { lat: 40.6892, lng: -74.0445 }],
    ["N 40.6892 W 74.0445", { lat: 40.6892, lng: -74.0445 }],
    ["33.8688 S, 151.2093 E", { lat: -33.8688, lng: 151.2093 }],
  ])("parses decimal %s", (text, expected) => {
    const p = parseCoordinates(text)!;
    expect(p.lat).toBeCloseTo(expected.lat, 6);
    expect(p.lng).toBeCloseTo(expected.lng, 6);
  });

  it("parses degrees-minutes-seconds", () => {
    const p = parseCoordinates(`40°41'21.1"N 74°02'40.2"W`)!;
    expect(p.lat).toBeCloseTo(40.68919, 4);
    expect(p.lng).toBeCloseTo(-74.04450, 4);
  });

  it.each(["", "eiffel tower", "91, 10", "10, 190", "12"])("rejects %s", (text) => {
    expect(parseCoordinates(text)).toBeNull();
  });

  it("formats DMS and decimal", () => {
    expect(formatLatLng({ lat: 40.689247, lng: -74.044502 }, "decimal")).toBe("40.689247, -74.044502");
    expect(formatLatLng({ lat: 40.689247, lng: -74.044502 }, "dms")).toBe("40°41′21.3″N, 74°02′40.2″W");
  });
});

describe("GPX", () => {
  it("emits one timed point per second along the route", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const gpx = buildTimedGpx([{ lat: 0, lng: 0 }, { lat: 0, lng: 0.001 }], 10, start, "A & B");
    const times = [...gpx.matchAll(/<time>(.*?)<\/time>/g)].map((m) => Date.parse(m[1]));
    const length = haversine({ lat: 0, lng: 0 }, { lat: 0, lng: 0.001 });
    expect(times[0]).toBe(start.getTime());
    expect((times.at(-1)! - times[0]) / 1000).toBeCloseTo(length / 10, 0);
    expect(gpx).toContain("<name>A &amp; B</name>");
  });
});
