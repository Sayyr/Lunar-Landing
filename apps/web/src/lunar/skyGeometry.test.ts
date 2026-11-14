import { describe, expect, it } from "vitest";

import { mockCelestialState } from "../mock/celestialMock";
import { localAzEl, moonSky, type Vec3 } from "./skyGeometry";

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

describe("moonSky (from the synthetic mock)", () => {
  const sky = moonSky(mockCelestialState(new Date("2026-11-15T00:00:00Z")));

  it("returns unit vectors", () => {
    for (const v of [sky.sun, sky.earth]) close(Math.hypot(...v), 1, 1e-12);
  });

  it("mean-orientation mock: Earth over lon 0°, within the Moon's ecliptic latitude (≤ 5.3°)", () => {
    close(sky.earth[1], 0, 1e-12);
    expect(Math.abs(Math.asin(sky.earth[2]) * 180 / Math.PI)).toBeLessThan(5.3);
  });

  it("Sun–Moon–Earth angle matches the mock's phase angle", () => {
    const s = mockCelestialState(new Date("2026-11-15T00:00:00Z"));
    const ang = (Math.acos(sky.sun[0] * sky.earth[0] + sky.sun[1] * sky.earth[1] + sky.sun[2] * sky.earth[2]) * 180) / Math.PI;
    close(ang, s.derived.phase_angle_deg, 1e-6);
  });

  it("earthToBody is a rotation", () => {
    const m = sky.earthToBody;
    const det =
      m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    close(det, 1, 1e-9);
  });
});
