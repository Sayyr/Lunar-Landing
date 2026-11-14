import { describe, expect, it } from "vitest";

import { periodicNoise, rng } from "./regolith";

describe("regolith detail (illustrative)", () => {
  it("is deterministic for a seed", () => {
    expect(periodicNoise(32, 4, rng(3))).toEqual(periodicNoise(32, 4, rng(3)));
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
});
