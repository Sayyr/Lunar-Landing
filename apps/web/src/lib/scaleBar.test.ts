import { describe, expect, it } from "vitest";

import { niceScale } from "./scaleBar";

describe("niceScale", () => {
  it("picks the largest 1/2/5 × 10ⁿ that fits", () => {
    expect(niceScale(1, 120)).toMatchObject({ km: 100, px: 100, label: "100 km" });
    expect(niceScale(10, 120)).toMatchObject({ km: 1000, label: "1 000 km" });
    expect(niceScale(0.04, 120)).toMatchObject({ km: 2, label: "2 km" });
    expect(niceScale(0.005, 120)?.label).toBe("500 m");
  });

  it("bar length stays within (maxPx / 2.5, maxPx]", () => {
    for (const k of [0.0013, 0.07, 3.3, 41, 777]) {
      const s = niceScale(k, 120)!;
      expect(s.px).toBeLessThanOrEqual(120 + 1e-9);
      expect(s.px).toBeGreaterThan(120 / 2.5);
    }
  });

  it("rejects non-positive or non-finite input", () => {
    expect(niceScale(0)).toBeNull();
    expect(niceScale(Number.NaN)).toBeNull();
    expect(niceScale(Infinity)).toBeNull();
  });
});
