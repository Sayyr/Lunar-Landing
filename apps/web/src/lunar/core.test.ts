// Ported from apps/moon-explorer/tests/core.test.mjs (node:test → vitest). Same cases.
import { describe, expect, it } from "vitest";

import { FeatureIndex, type FeaturesJson, normalizeName } from "./features";
import { formatLat, formatLon, haversineKm, latLonToUnit, normalizeLon, pointToUv, roundLon, uvToLatLon } from "./geo";
import { flipRowsInPlace, Heightmap } from "./heightmap";

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe("geo", () => {
  it("normalizeLon wraps into [-180, 180)", () => {
    expect(normalizeLon(180)).toBe(-180);
    expect(normalizeLon(-180)).toBe(-180);
    expect(normalizeLon(358.5)).toBe(-1.5);
    expect(normalizeLon(540)).toBe(-180);
    expect(normalizeLon(-190)).toBe(170);
  });

  it("UV formulas: lon = u*360-180, lat = v*180-90", () => {
    expect(uvToLatLon(0.5, 0.5)).toEqual({ lat: 0, lon: 0 });
    expect(uvToLatLon(0.75, 1)).toEqual({ lat: 90, lon: 90 });
    expect(uvToLatLon(1, 0)).toEqual({ lat: -90, lon: -180 });
  });

  it("three.js orientation: lon 0 on +X, lon +90 E on -Z, north on +Y", () => {
    let p = latLonToUnit(0, 0);
    close(p.x, 1);
    close(p.y, 0);
    close(p.z, 0);
    p = latLonToUnit(0, 90);
    close(p.x, 0);
    close(p.z, -1);
    p = latLonToUnit(90, 0);
    close(p.y, 1);
  });

  it("latLonToUnit ∘ pointToUv ∘ uvToLatLon = identity (off the poles)", () => {
    for (const [lat, lon] of [[0, 0], [45, 120], [-30, -170], [89.5, 10], [-89.5, -100], [12, 179.9]]) {
      const p = latLonToUnit(lat, lon);
      const { u, v } = pointToUv(p.x * 1.3, p.y * 1.3, p.z * 1.3); // any radius
      const r = uvToLatLon(u, v);
      close(r.lat, lat, 1e-9);
      close(haversineKm(lat, lon, r.lat, r.lon), 0, 1e-6);
    }
  });

  it("is deterministic at the poles and rejects the zero vector", () => {
    expect(uvToLatLon(...(Object.values(pointToUv(0, -1, 0)) as [number, number]))).toEqual({ lat: -90, lon: 0 });
    expect(() => pointToUv(0, 0, 0)).toThrow();
  });

  it("haversine: quarter meridian, symmetry, antimeridian", () => {
    close(haversineKm(0, 0, 90, 0), (Math.PI / 2) * 1737.4, 1e-6);
    close(haversineKm(10, 20, -5, 170), haversineKm(-5, 170, 10, 20), 1e-9);
    close(haversineKm(0, 179.9, 0, -179.9), 0.2 * (Math.PI / 180) * 1737.4, 1e-6);
  });

  it("roundLon stays in [-180, 180) after rounding", () => {
    expect(roundLon(179.99996, 4)).toBe(-180);
    expect(roundLon(-12.345678, 4)).toBe(-12.3457);
  });

  it("formats N/S/E/W and the pole", () => {
    expect(formatLat(-43.31)).toBe("43.310° S");
    expect(formatLon(-11.36)).toBe("11.360° W");
    expect(formatLon(20, 90)).toBe("— (pole)");
  });
});

describe("heightmap", () => {
  it("flipRowsInPlace reverses rows without losing data", () => {
    const W = 3;
    const H = 5;
    const d = Float32Array.from({ length: W * H }, (_, i) => i);
    flipRowsInPlace(d, W, H);
    expect([...d.subarray(0, 3)]).toEqual([12, 13, 14]);
    expect([...d.subarray(6, 9)]).toEqual([6, 7, 8]); // middle row unchanged
    expect([...d.subarray(12, 15)]).toEqual([0, 1, 2]);
  });

  it("pixel ↔ lat/lon, interpolation and ±180° seam", () => {
    // 8×4 px: TIFF row 0 = north. Mark pixel (row 0, column 0).
    const W = 8;
    const H = 4;
    const d = new Float32Array(W * H);
    d[0] = 4; // centre: lat 90 − 22.5 = 67.5; lon −180 + 22.5 = −157.5
    d[W - 1] = 2; // column 7: lon 157.5
    flipRowsInPlace(d, W, H);
    const hm = new Heightmap(d, W, H);
    close(hm.sampleKm(67.5, -157.5), 4);
    close(hm.sampleKm(67.5, 157.5), 2);
    close(hm.sampleKm(67.5, 180), 3); // halfway between columns 7 and 0 → continuous seam
    close(hm.sampleKm(67.5, -180), 3);
    close(hm.sampleKm(89.9, -157.5), 4); // beyond the last centre: clamped
    close(hm.sampleKm(-67.5, -157.5), 0);
    expect(hm.maxKm).toBe(4);
  });
});

const FIXTURE: FeaturesJson = {
  types: { AA: "Crater, craters", ME: "Mare, maria" },
  features: [
    ["Tycho", "AA", 85.29, -43.2961, -11.2152],
    ["Tycho A", "AA", 29.0, -39.9, -12.1],
    ["Mare Imbrium", "ME", 1146, 34.72, -14.91],
    ["Shackleton", "AA", 20.9, -89.67, 129.78],
    ["Bord", "AA", 10, 0, 179.95],
    ["Polaire", "AA", 60, -89.5, 0], // fictitious: crossing-the-pole test
  ],
};

describe("FeatureIndex", () => {
  it("nearest: only within the radius", () => {
    const idx = new FeatureIndex(FIXTURE);
    expect(idx.nearest(-43.3, -11.2)?.name).toBe("Tycho");
    expect(idx.nearest(-39.9, -12.1)?.name).toBe("Tycho A");
    expect(idx.nearest(0, 90)).toBeNull();
    expect(idx.nearest(34, -15)?.name).toBe("Mare Imbrium"); // large feature (linear list)
  });

  it("nearest: pole and antimeridian", () => {
    const idx = new FeatureIndex(FIXTURE);
    expect(idx.nearest(-89.7, 120)?.name).toBe("Shackleton");
    expect(idx.nearest(-90, 0)?.name).toBe("Shackleton"); // 10.0 km from centre < 10.45 km
    expect(idx.nearest(-89.6, -150)?.name).toBe("Polaire"); // other side of the pole
    expect(idx.nearest(0, -179.95)?.name).toBe("Bord"); // crosses ±180°
  });

  it("nearest agrees with an exhaustive search", () => {
    // Deterministic pseudo-random features (LCG), radii ≤ 150 km plus a few large ones.
    let s = 42;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const feats: FeaturesJson["features"] = [];
    for (let i = 0; i < 3000; i++) {
      const lat = (Math.asin(2 * rnd() - 1) * 180) / Math.PI;
      feats.push([`F${i}`, "AA", i % 100 === 0 ? 600 * rnd() + 300 : 300 * rnd(), lat, 360 * rnd() - 180]);
    }
    const idx = new FeatureIndex({ types: {}, features: feats });
    for (let k = 0; k < 2000; k++) {
      const lat = k < 100 ? 85 + 5 * rnd() : (Math.asin(2 * rnd() - 1) * 180) / Math.PI;
      const lon = 360 * rnd() - 180;
      let best: string | null = null;
      let bd = Infinity;
      for (const f of idx.features) {
        const d = haversineKm(lat, lon, f.lat, f.lon);
        if (d <= f.radiusKm && d < bd) {
          bd = d;
          best = f.name;
        }
      }
      expect(idx.nearest(lat, lon)?.name ?? null, `lat ${lat} lon ${lon}`).toBe(best);
    }
  });

  it("search: accents, prefix, size", () => {
    const idx = new FeatureIndex(FIXTURE);
    expect(normalizeName("Ångström")).toBe("angstrom");
    expect(idx.search("tycho").map((f) => f.name)).toEqual(["Tycho", "Tycho A"]);
    expect(idx.search("imbr")[0].name).toBe("Mare Imbrium");
    expect(idx.search("")).toEqual([]);
  });
});
