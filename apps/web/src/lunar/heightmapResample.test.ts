import { describe, expect, it } from "vitest";

import { Heightmap } from "./heightmap";

const W = 8;
const H = 4;

describe("Heightmap.resampled", () => {
  it("matches sampleKm at every target pixel centre", () => {
    const src = new Heightmap(Float32Array.from({ length: W * H }, (_, i) => Math.sin(i) * 3), W, H);
    const w = 20;
    const h = 10;
    const out = src.resampled(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const lat = ((y + 0.5) / h) * 180 - 90;
        const lon = ((x + 0.5) / w) * 360 - 180;
        expect(out[y * w + x]).toBeCloseTo(src.sampleKm(lat, lon), 5);
      }
  });
});

describe("Heightmap.extendRange", () => {
  it("widens min/max with overwritten rows only", () => {
    const hm = new Heightmap(new Float32Array(W * H), W, H);
    hm.data[W * 3 + 1] = 9;
    hm.data[W * 0] = -4;
    hm.extendRange(3, 1);
    expect(hm.maxKm).toBe(9);
    expect(hm.minKm).toBe(0); // row 0 not re-scanned
  });
});

describe("Heightmap.sampleKmSmooth", () => {
  const hm = new Heightmap(Float32Array.from({ length: W * H }, (_, i) => Math.cos(i * 1.7) * 2), W, H);
  const centre = (r: number, c: number) => ({ lat: ((r + 0.5) / H) * 180 - 90, lon: ((c + 0.5) / W) * 360 - 180 });

  it("passes through pixel values, like the bilinear sampler", () => {
    for (const [r, c] of [[1, 2], [2, 5], [1, 7]]) {
      const { lat, lon } = centre(r, c);
      expect(hm.sampleKmSmooth(lat, lon)).toBeCloseTo(hm.data[r * W + c], 6);
    }
  });

  it("slope is continuous across a pixel centre (bilinear's has a kink there)", () => {
    const { lat } = centre(1, 3);
    const e = 1e-3;
    const slope = (f: (la: number, lo: number) => number, lo: number) => (f(lat, lo + e) - f(lat, lo - e)) / (2 * e);
    const smooth = (la: number, lo: number) => hm.sampleKmSmooth(la, lo);
    const lin = (la: number, lo: number) => hm.sampleKm(la, lo);
    const centreLon = ((4 + 0.5) / W) * 360 - 180; // a pixel centre: bilinear kink
    const jumpSmooth = Math.abs(slope(smooth, centreLon - 4 * e) - slope(smooth, centreLon + 4 * e));
    const jumpLin = Math.abs(slope(lin, centreLon - 4 * e) - slope(lin, centreLon + 4 * e));
    expect(jumpSmooth).toBeLessThan(jumpLin / 20);
  });
});
