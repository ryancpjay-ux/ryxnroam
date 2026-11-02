import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStyle } from "../../src/renderer/lib/mapStyles";

// Minimal stand-ins for OpenFreeMap's published styles (shape only, no network).
const layer = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, source: "openmaptiles", ...extra });
const base = (layers: unknown[]) => ({
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sprite: "https://tiles.openfreemap.org/sprites/ofm_f384/ofm",
  sources: { openmaptiles: { type: "vector", url: "https://tiles.openfreemap.org/planet" } },
  layers,
});
const STYLES: Record<string, unknown> = {
  dark: base([layer("background", "background"), layer("road", "line"), layer("place_city", "symbol", { "source-layer": "place" })]),
  positron: base([layer("background", "background"), layer("airport", "symbol"), layer("place_city", "symbol", { "source-layer": "place" })]),
  liberty: base([
    layer("road_minor", "line", { "source-layer": "transportation" }),
    layer("road_one_way_arrow", "symbol"),
    layer("poi_r1", "symbol", { "source-layer": "poi", paint: { "text-color": "#666" } }),
    layer("airport", "symbol"),
    layer("label_city", "symbol", { "source-layer": "place" }),
  ]),
};

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  vi.stubGlobal("fetch", async (url: string) => Response.json(STYLES[url.split("/styles/")[1]]));
}

const ids = (s: unknown) => (s as { layers: { id: string }[] }).layers.map((l) => l.id);

describe("map styles", () => {
  it("adds place labels to Dark, below town names", async () => {
    stubFetch();
    const style = await buildStyle("dark");
    expect(ids(style)).toEqual(["background", "road", "poi_r1", "airport", "place_city"]);
  });

  it("never duplicates a layer id the base already has (Light has its own airport)", async () => {
    stubFetch();
    const style = await buildStyle("light");
    const list = ids(style);
    expect(new Set(list).size).toBe(list.length);
    expect(list).toContain("poi_r1");
  });

  it("uses published URLs for styles that already have place labels", async () => {
    expect(await buildStyle("streets")).toBe("https://tiles.openfreemap.org/styles/liberty");
  });
});
