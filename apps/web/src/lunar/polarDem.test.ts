import { afterEach, describe, expect, it, vi } from "vitest";

import { PolarDem, polarLevelFor, type PolarManifest, polarPixel, toLevel } from "./polarDem";

// Projection of LDEM_85S_20M as written by scripts/tile_polar_dem.py (signs validated there).
const real: PolarManifest = {
  source: "ldem_85s_20m_float.img",
  frame: "MEAN EARTH/POLAR AXIS OF DE421",
  projection: { center_lat: -90, center_lon: 0, radius_m: 1_737_400, line_off: 7583.5, sample_off: 7583.5, scale_m: 20, sign_y: 1, sign_line: -1 },
  tile: 256,
  levels: [{ level: 0, scale_m: 20, lines: 15168, samples: 15168, rows: 60, cols: 60 }],
  validation: { median_abs_km: 0.028, rms_km: 0.056 },
};

afterEach(() => vi.unstubAllGlobals());

describe("polarPixel matches the Python tiler", () => {
  // Reference values printed by tile_polar_dem.project() for the same points.
  const ref: [number, number, number, number][] = [
    [-89.67, 129.78, 7903.636152, 7968.012188],
    [-89.5, 0, 6825.411428, 7583.5],
    [-86.0, -45.0, 3293.388059, 3293.388059],
    [-90.0, 0.0, 7583.5, 7583.5],
  ];
  it.each(ref)("lat %f lon %f", (lat, lon, line, sample) => {
    const p = polarPixel(real, lat, lon);
    expect(p.line).toBeCloseTo(line, 4);
    expect(p.sample).toBeCloseTo(sample, 4);
  });

  it("level n halves the pixel grid about pixel centres", () => {
    expect(toLevel(0.5, 1)).toBeCloseTo(0); // level-0 pixels 0 and 1 → level-1 pixel 0
    expect(toLevel(7583.5, 3)).toBeCloseTo(947.5);
  });
});

describe("PolarDem sampling", () => {
  // Tiny synthetic product: 8×8 px of 100 m, 4-px tiles, height = 0.01·line + 0.001·sample km.
  const m: PolarManifest = {
    ...real,
    projection: { ...real.projection, line_off: 3.5, sample_off: 3.5, scale_m: 100 },
    tile: 4,
    levels: [{ level: 0, scale_m: 100, lines: 8, samples: 8, rows: 2, cols: 2 }],
  };
  const tileBuf = (row: number, col: number) => {
    const buf = new ArrayBuffer(8 + 16 * 2);
    const head = new DataView(buf);
    head.setFloat32(0, 0, true);
    head.setFloat32(4, 0.001, true);
    const v = new Uint16Array(buf, 8);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) v[i * 4 + j] = 10 * (row * 4 + i) + (col * 4 + j);
    return buf;
  };

  it("loads the needed tiles and interpolates across tile borders (linear field is exact)", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      const [, r, c] = url.match(/L0\/(\d+)_(\d+)\.u16$/)!;
      return new Response(tileBuf(Number(r), Number(c)));
    });
    const dem = new PolarDem(m, "/p/");
    await dem.loadAround(-90, 0, [{ level: 0, radiusM: 200 }]);
    expect(urls).toHaveLength(4);
    // At the pole: pixel (3.5, 3.5), straddling all four tiles.
    expect(dem.sampleKm(-90, 0, 0)).toBeCloseTo(0.01 * 3.5 + 0.001 * 3.5, 6);
  });

  it("returns NaN where tiles are missing or outside the product", async () => {
    vi.stubGlobal("fetch", async () => new Response(null, { status: 404 }));
    const dem = new PolarDem(m, "/p/");
    await dem.loadAround(-90, 0, [{ level: 0, radiusM: 200 }]);
    expect(Number.isNaN(dem.sampleKm(-90, 0, 0))).toBe(true);
    expect(Number.isNaN(dem.sampleKm(-80, 0, 0))).toBe(true);
  });
});

describe("polarLevelFor", () => {
  it("finest near the observer, none beyond the plan", () => {
    expect(polarLevelFor(100)).toBe(0);
    expect(polarLevelFor(10_000)).toBe(1);
    expect(polarLevelFor(50_000)).toBe(2);
    expect(polarLevelFor(120_000)).toBe(3);
    expect(polarLevelFor(300_000)).toBe(-1);
  });
});
