import { describe, expect, it } from "vitest";

import { childTiles, firstUsefulLevel, levelPxPerDeg, rootTiles, tileBounds, tileKey, tileToGlobalUv, tileUrl } from "./tileScheme";

describe("Moon Trek tile scheme", () => {
  it("level 0 is two 180° tiles from −180° and +90°", () => {
    expect(rootTiles().map(tileBounds)).toEqual([
      { west: -180, east: 0, south: -90, north: 90 },
      { west: 0, east: 180, south: -90, north: 90 },
    ]);
  });

  it("children split the parent exactly", () => {
    const p = { z: 3, row: 2, col: 9 };
    const b = tileBounds(p);
    const cs = childTiles(p).map(tileBounds);
    expect(Math.min(...cs.map((c) => c.west))).toBe(b.west);
    expect(Math.max(...cs.map((c) => c.east))).toBe(b.east);
    expect(Math.min(...cs.map((c) => c.south))).toBe(b.south);
    expect(Math.max(...cs.map((c) => c.north))).toBe(b.north);
  });

  it("URL follows {z}/{row}/{col}", () => {
    expect(tileUrl({ z: 7, row: 50, col: 100 })).toMatch(/\/default028mm\/7\/50\/100\.jpg$/);
    expect(tileKey({ z: 7, row: 50, col: 100 })).toBe("7/50/100");
  });

  it("resolution doubles per level; level 8 reaches the mosaic's 303 px/°", () => {
    expect(levelPxPerDeg(0)).toBeCloseTo(256 / 180);
    expect(levelPxPerDeg(8)).toBeGreaterThanOrEqual(303);
    expect(levelPxPerDeg(7)).toBeLessThan(303);
  });

  it("first useful level beats a 4096-px base texture (11.4 px/°)", () => {
    const z = firstUsefulLevel(4096);
    expect(levelPxPerDeg(z)).toBeGreaterThan(4096 / 360);
    expect(levelPxPerDeg(z - 1)).toBeLessThanOrEqual(4096 / 360);
  });

  it("tile UV → global raster UV: corners land on the tile's lon/lat bounds", () => {
    const id = { z: 5, row: 7, col: 40 };
    const b = tileBounds(id);
    const t = tileToGlobalUv(id);
    const lonOf = (u: number) => u * 360 - 180;
    const latOf = (v: number) => v * 180 - 90;
    expect(lonOf(t.offsetU)).toBeCloseTo(b.west);
    expect(latOf(t.offsetV)).toBeCloseTo(b.south);
    expect(lonOf(t.offsetU + t.scaleU)).toBeCloseTo(b.east);
    expect(latOf(t.offsetV + t.scaleV)).toBeCloseTo(b.north);
  });
});
