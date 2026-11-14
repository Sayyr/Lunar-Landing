import { describe, expect, it } from "vitest";

import { skyPlotXY } from "./SkyCompass";

describe("skyPlotXY (compass sky plot)", () => {
  it("zenith at the centre, horizon on the ring, azimuth clockwise from north (up)", () => {
    const z = skyPlotXY({ azimuthDeg: 123, elevationDeg: 90 }, 46);
    expect(Math.hypot(z.x, z.y)).toBeCloseTo(0);
    const east = skyPlotXY({ azimuthDeg: 90, elevationDeg: 0.001 }, 46);
    expect(east.x).toBeCloseTo(46, 1);
    expect(east.y).toBeCloseTo(0, 1);
    const north30 = skyPlotXY({ azimuthDeg: 0, elevationDeg: 30 }, 46);
    expect(north30.x).toBeCloseTo(0);
    expect(north30.y).toBeCloseTo((-46 * 60) / 90); // up on screen, 2/3 of the radius
  });

  it("below the horizon: just outside the ring, flagged", () => {
    const p = skyPlotXY({ azimuthDeg: 180, elevationDeg: -5 }, 46);
    expect(p.up).toBe(false);
    expect(p.y).toBeGreaterThan(46);
  });
});
