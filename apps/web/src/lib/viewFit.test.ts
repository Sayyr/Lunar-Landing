import { describe, expect, it } from "vitest";

import { centreShift, easeInOutQuad, refitDistance } from "./viewFit";

describe("easeInOutQuad", () => {
  it("starts at 0, ends at 1, passes 0.5 at mid-time and is symmetric", () => {
    expect(easeInOutQuad(0)).toBe(0);
    expect(easeInOutQuad(1)).toBe(1);
    expect(easeInOutQuad(0.5)).toBeCloseTo(0.5, 12);
    for (const k of [0.1, 0.25, 0.4]) expect(easeInOutQuad(k) + easeInOutQuad(1 - k)).toBeCloseTo(1, 12);
  });
});

describe("centreShift", () => {
  it("moves the view centre to the middle of the free band", () => {
    expect(centreShift(290, 130)).toBe(80);
    expect(centreShift(0, 0)).toBe(0);
    expect(centreShift(320, 380)).toBe(-30);
  });
});

describe("refitDistance", () => {
  const apparent = (d: number) => 1 / Math.sqrt(d * d - 1);

  it("keeps the distance when the free width does not change", () => {
    expect(refitDistance(3.2, 1)).toBeCloseTo(3.2, 12);
  });

  it("scales the projected disc size by the free-width ratio, from orbit and close up", () => {
    for (const d0 of [1.05, 1.5, 3.2, 8]) {
      for (const k of [0.6, 1.4]) expect(apparent(refitDistance(d0, k)) / apparent(d0)).toBeCloseTo(k, 9);
    }
  });

  it("moves away when the free width shrinks", () => {
    expect(refitDistance(3.2, 0.7)).toBeGreaterThan(3.2);
  });
});
