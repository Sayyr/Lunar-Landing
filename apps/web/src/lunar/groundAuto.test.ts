import { describe, expect, it } from "vitest";

import { findHighGround, sunClearsTerrain } from "./groundAuto";
import { buildGroundTerrain } from "./groundTerrain";
import { haversineKm } from "./geo";

const opt = { bearings: 72, rings: 40, minDistanceM: 5, maxDistanceM: 400_000 };

describe("sunClearsTerrain", () => {
  const t = buildGroundTerrain(null, 0, 0, 2, opt); // smooth sphere: horizon just below 0°
  it("whole disc above the terrain horizon", () => {
    expect(sunClearsTerrain({ azimuthDeg: 90, elevationDeg: 1 }, t)).toBe(true);
    expect(sunClearsTerrain({ azimuthDeg: 90, elevationDeg: 0.1 }, t)).toBe(false); // disc not fully up
    expect(sunClearsTerrain({ azimuthDeg: 90, elevationDeg: -2 }, t)).toBe(false);
  });
});

describe("findHighGround", () => {
  it("searches within the radius, around the site, also near the pole", () => {
    for (const [lat, lon] of [[10, 20], [-89.5, 0]]) {
      // Elevation = distance from the site: the farthest grid point (≈ the radius) wins.
      const far = findHighGround((_la, _lo, d) => d, lat, lon, 12_000, 500)!;
      expect(far.distanceM).toBeGreaterThan(11_500);
      expect(far.distanceM).toBeLessThanOrEqual(12_000);
      expect(haversineKm(far.lat, far.lon, lat, lon) * 1000).toBeCloseTo(far.distanceM, -1);
    }
  });

  it("picks the highest sampled elevation", () => {
    const target = { lat: -89.45, lon: -137 };
    const src = (la: number, lo: number) => -haversineKm(la, lo, target.lat, target.lon) * 1000; // peak at target
    const hg = findHighGround(src, -89.5, 0, 30_000, 300)!;
    expect(haversineKm(hg.lat, hg.lon, target.lat, target.lon)).toBeLessThan(0.3);
  });

  it("null without a terrain source", () => {
    expect(findHighGround(null, 0, 0)).toBeNull();
  });
});
