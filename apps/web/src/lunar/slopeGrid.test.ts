import { describe, expect, it } from "vitest";

import { fractionAtMost, fractionColour, parseSlopeGrid, rankDiscs, type SlopeGridFile } from "./slopeGrid";

function file(hists: number[][], mean: number[]): SlopeGridFile {
  const n = hists.length;
  return {
    status: "test",
    source: { product_id: "TEST", sha256: null },
    method: { disc_diameter_m: 4000, step_m: 4000, grids: [{ id: 0, offset_steps: [0, 0], discs: n }], histogram: { bin_deg: 0.5, bins: 8 } },
    scale_warning: "",
    columns: {
      grid: hists.map(() => 0),
      x_km: hists.map((_, i) => i * 4),
      y_km: hists.map(() => 0),
      lat: hists.map(() => -89),
      lon: hists.map(() => 0),
      valid_px: hists.map((h) => h.reduce((a, b) => a + b, 0)),
      nodata_px: hists.map(() => 0),
      mean_deg: mean,
      max_deg: mean,
      hist: hists,
    },
  };
}

describe("slope grid", () => {
  const g = parseSlopeGrid(file([[10, 0, 30], [40], [], [20, 20]], [1, 0.1, NaN, 0.4]));

  it("computes the share of pixels at or below a threshold from trimmed histograms", () => {
    const [a, b, empty] = g.discs;
    expect(fractionAtMost(a, 0.5, g.binDeg)).toBeCloseTo(0.25, 12); // bin 0 = [0, 0.5)
    expect(fractionAtMost(a, 1.0, g.binDeg)).toBeCloseTo(0.25, 12);
    expect(fractionAtMost(a, 1.5, g.binDeg)).toBe(1);
    expect(fractionAtMost(a, 100, g.binDeg)).toBe(1); // beyond the last bin
    expect(fractionAtMost(a, 0, g.binDeg)).toBe(0);
    expect(fractionAtMost(a, 1.2, g.binDeg)).toBeCloseTo(0.25, 12); // rounded down to 1.0 (conservative)
    expect(fractionAtMost(b, 0.5, g.binDeg)).toBe(1);
    expect(fractionAtMost(empty, 5, g.binDeg)).toBeNaN();
  });

  it("ranks by share, then by lower mean slope, skipping empty discs", () => {
    const r = rankDiscs(g.discs, 1.0, g.binDeg, 10);
    expect(r.map((x) => x.disc.index)).toEqual([1, 3, 0]);
    expect(rankDiscs(g.discs, 5, g.binDeg, 10).map((x) => x.disc.index)).toEqual([1, 3, 0]); // all 100 %: mean slope
    expect(rankDiscs(g.discs, 5, g.binDeg, 1)).toHaveLength(1);
  });

  it("colours red below 50 %, green at 100 %, grey without data", () => {
    expect(fractionColour(0.2)).toEqual([229, 83, 75]);
    expect(fractionColour(1)).toEqual([47, 200, 90]);
    expect(fractionColour(0.75)).toEqual([242, 193, 78]);
    expect(fractionColour(NaN)).toEqual([110, 110, 110]);
  });
});
