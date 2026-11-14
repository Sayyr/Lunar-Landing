import { describe, expect, it } from "vitest";

import { buildGroundTerrain, type GroundTerrain, heightmapSource, horizonAt, MOON_RADIUS_M } from "./groundTerrain";
import { Heightmap } from "./heightmap";

/** Elevation angle (degrees) of a terrain vertex seen from the eye. */
function vertexElevationDeg(t: GroundTerrain, v: number): number {
  const [x, y, z] = [t.positions[3 * v], t.positions[3 * v + 1], t.positions[3 * v + 2]];
  return (Math.atan2(y, Math.hypot(x, z)) * 180) / Math.PI;
}
const flat = heightmapSource(null);

const opt = { bearings: 36, rings: 40, minDistanceM: 5, maxDistanceM: 400_000 };
const ringVertex = (ring: number, bearingIdx: number) => 1 + ring * opt.bearings + bearingIdx;
const ringDistance = (ring: number) => opt.minDistanceM * (opt.maxDistanceM / opt.minDistanceM) ** (ring / (opt.rings - 1));

describe("buildGroundTerrain on a smooth sphere (no raster)", () => {
  const t = buildGroundTerrain(flat, 10, 20, 2, opt);

  it("vertex 0 is the ground under the eye", () => {
    expect([t.positions[0], t.positions[1], t.positions[2]]).toEqual([0, -2, 0]);
  });

  it("dip of a surface point matches spherical geometry (curvature + eye height)", () => {
    for (const ring of [10, 25, 39]) {
      const d = ringDistance(ring);
      const delta = d / MOON_RADIUS_M;
      // Exact: point at central angle δ on radius R seen from radius R + h.
      const R = MOON_RADIUS_M;
      const h = 2;
      const expected = (Math.atan2(R * Math.cos(delta) - (R + h), R * Math.sin(delta)) * 180) / Math.PI;
      expect(vertexElevationDeg(t, ringVertex(ring, 7))).toBeCloseTo(expected, 4);
    }
  });

  it("bearing 0 is north (−z), bearing 90° is east (+x)", () => {
    const n = ringVertex(20, 0);
    const e = ringVertex(20, 9); // 9 × 10° = 90°
    expect(t.positions[3 * n + 2]).toBeLessThan(0);
    expect(Math.abs(t.positions[3 * n])).toBeLessThan(1e-3 * ringDistance(20));
    expect(t.positions[3 * e]).toBeGreaterThan(0);
    expect(Math.abs(t.positions[3 * e + 2])).toBeLessThan(1e-3 * ringDistance(20));
  });

  it("works at the exact south pole (no degenerate ring)", () => {
    const p = buildGroundTerrain(flat, -90, 0, 2, opt);
    const a = ringVertex(30, 0);
    const b = ringVertex(30, 18);
    expect(Math.hypot(p.positions[3 * a] - p.positions[3 * b], p.positions[3 * a + 2] - p.positions[3 * b + 2])).toBeGreaterThan(1.9 * ringDistance(30) * 0.99);
    expect(Array.from(p.positions).every(Number.isFinite)).toBe(true);
  });
});

describe("buildGroundTerrain with relief", () => {
  it("a raised raster lifts distant terrain above the smooth-sphere dip", () => {
    const W = 360;
    const H = 180;
    const level = new Heightmap(new Float32Array(W * H), W, H);
    const raised = new Heightmap(new Float32Array(W * H).fill(0), W, H);
    // +5 km everywhere north of 12° N; site at 10° N.
    for (let r = 0; r < H; r++) if ((r + 0.5) * (180 / H) - 90 > 12) raised.data.fill(5, r * W, (r + 1) * W);
    const a = buildGroundTerrain(heightmapSource(level), 10, 0, 2, opt);
    const b = buildGroundTerrain(heightmapSource(raised), 10, 0, 2, opt);
    const v = ringVertex(39, 0); // 400 km north
    expect(vertexElevationDeg(b, v)).toBeGreaterThan(vertexElevationDeg(a, v));
    expect(b.siteElevationM).toBeCloseTo(0);
  });
});

describe("buildGroundTerrain winding", () => {
  it("every triangle faces up (+y) on a smooth sphere, so lighting from the Sun works", () => {
    const t = buildGroundTerrain(flat, -45, 30, 2, opt);
    const p = t.positions;
    let down = 0;
    for (let k = 0; k < t.indices.length; k += 3) {
      const [a, b, c] = [t.indices[k], t.indices[k + 1], t.indices[k + 2]];
      const [ux, uz] = [p[3 * b] - p[3 * a], p[3 * b + 2] - p[3 * a + 2]];
      const [vx, vz] = [p[3 * c] - p[3 * a], p[3 * c + 2] - p[3 * a + 2]];
      // y component of (b − a) × (c − a): the face normal points up.
      if (uz * vx - ux * vz <= 0) down++;
    }
    expect(down).toBe(0);
  });
});

describe("terrain horizon profile", () => {
  it("smooth sphere: horizon is the dip of the nearest ring (just below 0°)", () => {
    const t = buildGroundTerrain(flat, 10, 20, 2, opt);
    for (const az of [0, 90, 123.4, 359]) {
      expect(horizonAt(t, az)).toBeLessThan(0);
      expect(horizonAt(t, az)).toBeGreaterThan(-25); // nearest ring 5 m away, eye 2 m up: atan(2/5) ≈ 21.8°
    }
  });

  it("a raised region raises the horizon only in its direction", () => {
    const W = 360;
    const H = 180;
    const hm = new Heightmap(new Float32Array(W * H), W, H);
    for (let r = 0; r < H; r++) if ((r + 0.5) * (180 / H) - 90 > 12) hm.data.fill(5, r * W, (r + 1) * W);
    const t = buildGroundTerrain(heightmapSource(hm), 10, 0, 2, opt);
    expect(horizonAt(t, 0)).toBeGreaterThan(0.5); // 5 km wall ~2° of latitude north
    expect(horizonAt(t, 180)).toBeLessThan(0);
  });
});
