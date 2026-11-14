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
