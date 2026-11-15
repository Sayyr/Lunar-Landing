import { describe, expect, it } from "vitest";

import { DEG } from "../lib/constants";
import { haversineKm, MOON_RADIUS_KM } from "./geo";
import { Heightmap } from "./heightmap";
import { LANDING_SITES } from "./landingSites";
import { analyseTopography, colourRelief, fractionAtMost, offsetLatLon, poleProximity, reliefGrid, shadedRelief } from "./siteTopography";

const W = 1440;
const H = 720; // 0.25° cells
function raster(f: (lat: number, lon: number) => number): Heightmap {
  const d = new Float32Array(W * H);
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) d[r * W + c] = f(-90 + (r + 0.5) * (180 / H), -180 + (c + 0.5) * (360 / W));
  return new Heightmap(d, W, H, "test");
}

describe("poleProximity", () => {
  it("uses the hemisphere of the latitude and the sphere distance", () => {
    expect(poleProximity(-80.1276)).toMatchObject({ pole: "south", band: "polar" });
    expect(poleProximity(-80.1276).distanceKm).toBeCloseTo(9.8724 * DEG * MOON_RADIUS_KM, 9);
    expect(poleProximity(44.1214)).toMatchObject({ pole: "north", band: "mid" });
    expect(poleProximity(-69.374).band).toBe("high");
    expect(poleProximity(0.67416).band).toBe("equatorial");
    expect(poleProximity(90).distanceKm).toBe(0);
  });

  it("classifies the band edges deterministically", () => {
    expect(poleProximity(80).band).toBe("polar");
    expect(poleProximity(-60).band).toBe("high");
    expect(poleProximity(29.999).band).toBe("equatorial");
    expect(poleProximity(0).pole).toBe("south");
  });

  it("covers every catalogued landing site", () => {
    for (const s of LANDING_SITES) expect(poleProximity(s.lat).distanceKm).toBeGreaterThan(0);
  });
});

describe("offsetLatLon", () => {
  it("places points at the requested ground distance and bearing", () => {
    const p = offsetLatLon(-84.79, 29.2, 30, 0);
    expect(haversineKm(-84.79, 29.2, p.lat, p.lon)).toBeCloseTo(30, 6);
    const q = offsetLatLon(10, 170, 0, 50);
    expect(q.lon).toBeCloseTo(170, 9);
    expect(q.lat).toBeCloseTo(10 + (50 / MOON_RADIUS_KM) / DEG, 9);
    expect(offsetLatLon(0, 179.9, 20, 0).lon).toBeLessThan(-179); // wraps across 180°
  });
});

describe("analyseTopography", () => {
  it("reports zero relief and slope on a flat raster", () => {
    const t = analyseTopography(raster(() => -1.5), 0.67, 23.47, 15)!;
    expect(t.elevationM).toBeCloseTo(-1500, 6);
    expect(t.reliefM).toBeCloseTo(0, 6);
    expect(t.maxSlopeDeg).toBeCloseTo(0, 9);
    expect(t.cells).toBeGreaterThan(0);
  });

  it("recovers a known north-south slope and relief", () => {
    const tan = Math.tan(3 * DEG);
    const hm = raster((lat) => (lat * DEG * MOON_RADIUS_KM * tan)); // km, rises northward at 3°
    const t = analyseTopography(hm, 20, -30, 20)!;
    expect(t.meanSlopeDeg).toBeCloseTo(3, 3);
    expect(t.slopeDeg).toBeCloseTo(3, 3);
    // cells span ~±20 km north-south (cell centres, so a little less)
    expect(t.reliefM).toBeGreaterThan(2 * 15 * 1000 * tan);
    expect(t.reliefM).toBeLessThanOrEqual(2 * 20 * 1000 * tan + 1e-6);
  });

  it("returns null when the raster has no data there", () => {
    expect(analyseTopography(raster(() => NaN), 10, 10)).toBeNull();
  });
});

describe("shadedRelief", () => {
  it("is uniform on flat ground and brighter on north-west-facing slopes", () => {
    const flat = shadedRelief(raster(() => 0), 0, 0, 30, 8);
    expect(new Set(Array.from(flat.filter((_, i) => i % 4 === 1))).size).toBe(1);
    const tan = Math.tan(10 * DEG);
    const facingNorth = shadedRelief(raster((lat) => -lat * DEG * MOON_RADIUS_KM * tan), 0, 0, 30, 8); // descends north
    const facingSouth = shadedRelief(raster((lat) => lat * DEG * MOON_RADIUS_KM * tan), 0, 0, 30, 8);
    expect(facingNorth[4 * 36 + 1]).toBeGreaterThan(facingSouth[4 * 36 + 1]);
  });
});

describe("slope colouring", () => {
  it("is green below the threshold, red above, and counts the fraction", () => {
    const tan = Math.tan(3 * DEG);
    const g = reliefGrid(raster((lat) => lat * DEG * MOON_RADIUS_KM * tan), 10, 10, 20, 6);
    const green = colourRelief(g, 5);
    const red = colourRelief(g, 2);
    const k = 4 * 14;
    expect(green[k + 1]).toBeGreaterThan(green[k]); // G > R
    expect(red[k]).toBeGreaterThan(red[k + 1]); // R > G
    expect(fractionAtMost(g.slopeDeg, 5)).toBe(1);
    expect(fractionAtMost(g.slopeDeg, 2)).toBe(0);
    expect(fractionAtMost([NaN, 1, 9], 5)).toBeCloseTo(0.5, 12);
    expect(fractionAtMost([NaN], 5)).toBeNaN();
  });
});
