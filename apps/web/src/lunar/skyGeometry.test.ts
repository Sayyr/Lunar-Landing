import { describe, expect, it } from "vitest";

import { localAzEl, type Vec3 } from "./skyGeometry";

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("localAzEl", () => {
  it("equator, lon 0: zenith, north, east, west quadrants", () => {
    expect(localAzEl([1, 0, 0], 0, 0).elevationDeg).toBeCloseTo(90);
    const n = localAzEl([0, 0, 1], 0, 0);
    close(n.azimuthDeg, 0);
    close(n.elevationDeg, 0);
    close(localAzEl([0, 1, 0], 0, 0).azimuthDeg, 90); // +Y = lon 90° E = east
    close(localAzEl([0, -1, 0], 0, 0).azimuthDeg, 270);
    close(localAzEl([-1, 0, 0], 0, 0).elevationDeg, -90);
  });

  it("azimuth stays in [0, 360)", () => {
    const a = localAzEl([0, -1e-15, 1], 0, 0).azimuthDeg;
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);
  });

  it("polar fallback is the prime-meridian limit and is continuous with it", () => {
    const d: Vec3 = [0.3, -0.5, 0.2];
    for (const lat of [-90, 90]) {
      const exact = localAzEl(d, lat, 0);
      const near = localAzEl(d, lat - Math.sign(lat) * 1e-7, 0);
      close(exact.azimuthDeg, near.azimuthDeg, 1e-4);
      close(exact.elevationDeg, near.elevationDeg, 1e-4);
    }
    // At the south pole, north = +X: a +X horizon direction is azimuth 0.
    close(localAzEl([1, 0, 0], -90, 123).azimuthDeg, 0);
    expect(localAzEl([0, 0, -1], -90, 0).elevationDeg).toBeCloseTo(90);
  });
});
