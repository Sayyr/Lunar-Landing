import type { BufferGeometry, Points } from "three";
import { describe, expect, it } from "vitest";

import { equatorialToEcliptic, makeStarField } from "./stars";
import data from "./stars.json";

describe("equatorialToEcliptic", () => {
  it("maps the north ecliptic pole (RA 18h, Dec +66.56°) to ecliptic +Z", () => {
    const [x, y, z] = equatorialToEcliptic(270, 66.5607089);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(1, 6);
  });

  it("keeps the vernal equinox on ecliptic +X", () => {
    expect(equatorialToEcliptic(0, 0)).toEqual([1, 0, 0]);
  });
});

describe("makeStarField", () => {
  it("draws every catalogue star once, on the requested sphere", () => {
    const radius = 90;
    const group = makeStarField(radius);
    let count = 0;
    for (const child of group.children) {
      const pos = (child as Points<BufferGeometry>).geometry.getAttribute("position");
      count += pos.count;
      for (let i = 0; i < pos.count; i += 97) expect(Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i))).toBeCloseTo(radius, 3);
    }
    expect(count).toBe(data.stars.length);
    expect(group.children).toHaveLength(3);
  });
});
