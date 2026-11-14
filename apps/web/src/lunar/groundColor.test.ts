import { describe, expect, it } from "vitest";

import { colorSourceFromPixels } from "./groundColor";

describe("colorSourceFromPixels", () => {
  // 4 × 2 equirectangular: left half grey 100, right half reddish (160, 100, 80).
  const W = 4;
  const H = 2;
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) px.set(x < 2 ? [100, 100, 100, 255] : [160, 100, 80, 255], 4 * (y * W + x));
  const src = colorSourceFromPixels(px, W, H);
  const at = (lat: number, lon: number) => {
    const out = new Float32Array(3);
    src(lat, lon, out, 0);
    return [...out];
  };

  it("maps lon −180…0 to the left half and 0…180 to the right half", () => {
    const [r, g, b] = at(10, -90);
    expect(r).toBeCloseTo(g, 6);
    expect(g).toBeCloseTo(b, 6);
    const [r2, , b2] = at(10, 90);
    expect(r2).toBeGreaterThan(b2);
  });

  it("keeps only part of the tint (reddish pixel desaturated toward its luminance)", () => {
    const [r, g, b] = at(10, 90);
    const spreadIn = (160 - 80) / 255;
    expect(r - b).toBeLessThan(spreadIn);
    expect(r - b).toBeGreaterThan(0);
    expect(g).toBeGreaterThan(0);
  });

  it("normalises the mean brightness to a regolith grey", () => {
    const vals = [at(45, -135), at(45, -45), at(45, 45), at(45, 135)].flat();
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
    expect(mean).toBeGreaterThan(0.5);
    expect(mean).toBeLessThan(0.75);
  });
});
