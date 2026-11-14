import { describe, expect, it } from "vitest";

import { DEG } from "../lib/constants";
import { coarseSlopeDeg } from "./coarseSlope";
import { MOON_RADIUS_KM } from "./geo";
import { Heightmap } from "./heightmap";

const W = 360;
const H = 180; // 1° cells
const cellM = (MOON_RADIUS_KM * 1000 * Math.PI) / H;

/** Raster (km) built from f(row, col) — row 0 = south. */
function raster(f: (row: number, col: number) => number): Heightmap {
  const d = new Float32Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) d[r * W + c] = f(r, c);
  return new Heightmap(d, W, H, "test");
}

describe("coarseSlopeDeg", () => {
  it("is 0 on a flat raster", () => {
    expect(coarseSlopeDeg(raster(() => 1.2), 10, 20)).toBeCloseTo(0, 9);
  });

  it("matches a known north-south gradient", () => {
    const rise = Math.tan(5 * DEG) * cellM; // metres per row → 5°
    const hm = raster((r) => (r * rise) / 1000);
    expect(coarseSlopeDeg(hm, 0.5, 0)).toBeCloseTo(5, 4);
    expect(coarseSlopeDeg(hm, -40.5, 100)).toBeCloseTo(5, 4);
  });

  it("uses the cos(lat)-shrunk east spacing", () => {
    // Same height step per column everywhere: steeper at 60° than at the equator (cos 60° = ½).
    const step = Math.tan(3 * DEG) * cellM;
    const hm = raster((_, c) => (Math.min(c, 300) * step) / 1000);
    const eq = coarseSlopeDeg(hm, 0.5, -100);
    const hi = coarseSlopeDeg(hm, 60.5, -100);
    expect(eq).toBeCloseTo(3, 3);
    expect(Math.tan(hi * DEG)).toBeCloseTo(Math.tan(3 * DEG) / Math.cos(60.5 * DEG), 3);
  });

  it("wraps longitude at ±180° and returns NaN near the poles / on no-data", () => {
    expect(Number.isFinite(coarseSlopeDeg(raster(() => 0), 0, 179.9))).toBe(true);
    expect(coarseSlopeDeg(raster(() => 0), -89.6, 0)).toBeNaN();
    expect(coarseSlopeDeg(raster((r, c) => (r === 90 && c === 181 ? NaN : 0)), 0.5, 0.5)).toBeNaN();
  });
});
