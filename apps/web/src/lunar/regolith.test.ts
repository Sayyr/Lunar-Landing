import { describe, expect, it } from "vitest";

import { normalsFromHeight, periodicNoise, regolithFields, rng } from "./regolith";

describe("regolith detail (illustrative)", () => {
  it("is deterministic for a seed", () => {
    expect(regolithFields(64, 3).height).toEqual(regolithFields(64, 3).height);
    expect(rng(1)()).toBe(rng(1)());
  });

  it("noise tiles seamlessly: last column/row continue into the first", () => {
    const s = 128;
    const n = periodicNoise(s, 8, rng(5));
    // Jump across the wrap edge is no larger than a typical neighbour step.
    let maxStep = 0;
    for (let y = 0; y < s; y++) for (let x = 0; x < s - 1; x++) maxStep = Math.max(maxStep, Math.abs(n[y * s + x + 1] - n[y * s + x]));
    for (let y = 0; y < s; y++) expect(Math.abs(n[y * s] - n[y * s + s - 1])).toBeLessThanOrEqual(maxStep + 1e-6);
    for (let x = 0; x < s; x++) expect(Math.abs(n[x] - n[(s - 1) * s + x])).toBeLessThanOrEqual(maxStep + 1e-6);
  });

  it("albedo stays a mild multiplier around 1", () => {
    const { albedo } = regolithFields(128, 9);
    const mean = albedo.reduce((a, b) => a + b, 0) / albedo.length;
    expect(mean).toBeGreaterThan(0.85);
    expect(mean).toBeLessThan(1.25);
    expect(Math.min(...albedo)).toBeGreaterThan(0.5);
  });
});

describe("regolith PBR maps", () => {
  it("flat height → straight-up normal (0.5, 0.5, 1)", () => {
    const n = normalsFromHeight(new Float32Array(16).fill(0.3), 4, 10);
    for (let i = 0; i < 16; i++) expect([n[3 * i], n[3 * i + 1], n[3 * i + 2]]).toEqual([0.5, 0.5, 1]);
  });

  it("a slope rising toward +x tilts the normal toward −x, unit length", () => {
    const s = 8;
    const h = Float32Array.from({ length: s * s }, (_, i) => (i % s) / s); // ramp in x (wraps)
    const n = normalsFromHeight(h, s, 4);
    const i = 3 * (3 * s + 3); // away from the wrap seam
    expect(n[i]).toBeLessThan(0.5);
    const v = [n[i] * 2 - 1, n[i + 1] * 2 - 1, n[i + 2] * 2 - 1];
    expect(Math.hypot(...v)).toBeCloseTo(1, 6);
  });

  it("roughness stays in the matte range of regolith", () => {
    const { roughness } = regolithFields(128, 2);
    expect(Math.min(...roughness)).toBeGreaterThanOrEqual(0.85);
    expect(Math.max(...roughness)).toBeLessThanOrEqual(1);
  });
});
