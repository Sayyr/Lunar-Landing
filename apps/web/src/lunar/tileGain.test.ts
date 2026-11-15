import { describe, expect, it } from "vitest";

import { luminanceGrid, meanLuminance, meanOverBox, tileGain } from "./tileGain";

const grey = (w: number, h: number, v: (x: number, y: number) => number) => {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.fill(v(x, y), (y * w + x) * 4, (y * w + x) * 4 + 3);
  return luminanceGrid(rgba, w, h);
};

describe("luminanceGrid", () => {
  it("decodes sRGB to linear luminance (white = 1, mid-grey 128 ≈ 0.216)", () => {
    expect(meanLuminance(grey(2, 2, () => 255))).toBeCloseTo(1, 6);
    expect(meanLuminance(grey(2, 2, () => 128))).toBeCloseTo(0.2158, 3);
  });
});

describe("meanOverBox", () => {
  const map = grey(360, 180, (_x, y) => (y < 90 ? 200 : 50));

  it("reads north at the top of an equirectangular map, lon −180 at the left edge", () => {
    const north = meanOverBox(map, { west: -10, east: 10, south: 30, north: 60 });
    const south = meanOverBox(map, { west: -10, east: 10, south: -60, north: -30 });
    expect(north).toBeGreaterThan(south);
  });

  it("still samples at least one pixel for a tile smaller than a reference pixel", () => {
    expect(meanOverBox(map, { west: 0, east: 0.01, south: 45, north: 45.01 })).toBeGreaterThan(0);
  });
});

describe("tileGain", () => {
  it("brightens a tile darker than the reference, within [0.5, 4]", () => {
    expect(tileGain(0.2, 0.1)).toBeCloseTo(2);
    expect(tileGain(1, 0.01)).toBe(4);
    expect(tileGain(0.01, 1)).toBe(0.5);
  });

  it("leaves the tile unchanged when a mean is unusable", () => {
    expect(tileGain(0, 0.3)).toBe(1);
    expect(tileGain(0.3, 0)).toBe(1);
  });
});
