import { describe, expect, it } from "vitest";

import { displayToLatLon, latLonToDisplay, wrapLongitudeDeg } from "./coords";

describe("wrapLongitudeDeg", () => {
  it.each([
    [0, 0],
    [180, -180],
    [-180, -180],
    [190, -170],
    [-190, 170],
    [540, -180],
  ])("%d -> %d", (raw, expected) => {
    expect(wrapLongitudeDeg(raw)).toBeCloseTo(expected, 12);
  });
});

describe("display sphere mapping", () => {
  it("places the north pole on +Y and lon 0 on +X", () => {
    const [x, y, z] = latLonToDisplay(90, 0);
    expect([x, y, z].map((v) => +v.toFixed(12))).toEqual([0, 1, 0]);
    expect(latLonToDisplay(0, 0)[0]).toBeCloseTo(1, 12);
    const east = latLonToDisplay(0, 90);
    expect(east[2]).toBeCloseTo(-1, 12);
  });

  it.each([
    [-89.5, 0],
    [-85, 45],
    [0, -179.9],
    [30, 120],
    [-45, -60],
  ])("round-trips (%d, %d)", (lat, lon) => {
    const p = displayToLatLon(...latLonToDisplay(lat, lon, 2.5));
    expect(p.latitude_deg).toBeCloseTo(lat, 10);
    expect(p.longitude_deg).toBeCloseTo(lon, 10);
  });

  it("is deterministic at the pole", () => {
    expect(displayToLatLon(0, -1, 0)).toEqual({ latitude_deg: -90, longitude_deg: 0 });
  });

  it("rejects the zero vector", () => {
    expect(() => displayToLatLon(0, 0, 0)).toThrow();
  });
});
