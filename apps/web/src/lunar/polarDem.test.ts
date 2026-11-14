import { afterEach, describe, expect, it, vi } from "vitest";

import { DemStack, PolarDem, type PolarManifest, polarPixel, toLevel } from "./polarDem";

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

describe("level selection by mesh spacing", () => {
  const four: PolarManifest = { ...real, levels: [0, 1, 2, 3].map((l) => ({ level: l, scale_m: 20 * 2 ** l, lines: 10, samples: 10, rows: 1, cols: 1 })) };
  const dem = new PolarDem(four, "/x/");

  it("coarsest level whose pixel is ≤ the spacing; past the pyramid → levels.length", () => {
    expect(dem.levelForSpacing(5)).toBe(0);
    expect(dem.levelForSpacing(39)).toBe(0);
    expect(dem.levelForSpacing(40)).toBe(1);
    expect(dem.levelForSpacing(170)).toBe(3);
    expect(dem.levelForSpacing(1000)).toBe(4);
  });

  it("download plan stops each level where the spacing reaches twice its pixel", () => {
    const plan = dem.planFor(0.032, 150_000); // 3.2 % ring spacing
    expect(plan.map((p) => p.level)).toEqual([0, 1, 2, 3]);
    expect(plan[0].radiusM).toBeCloseTo(40 / 0.032);
    expect(plan[2].radiusM).toBeCloseTo(160 / 0.032);
    expect(plan[3].radiusM).toBe(150_000);
  });
});

describe("DemStack", () => {
  // Minimal stand-ins: a product returns `value` where it has data, NaN elsewhere.
  const fake = (scales: number[], value: (l: number) => number) =>
    Object.assign(Object.create(PolarDem.prototype), {
      manifest: { ...real, levels: scales.map((s, l) => ({ level: l, scale_m: s, lines: 10, samples: 10, rows: 1, cols: 1 })) },
      sampleKm: (_la: number, _lo: number, l: number) => (l < scales.length ? value(l) : NaN),
    }) as PolarDem;
  const site = fake([5, 10], (l) => 1 + l); // km: 1 at 5 m, 2 at 10 m
  const polar = fake([20, 40, 80], (l) => 10 + l);
  const stack = new DemStack(
    [
      { dem: site, maxDistanceM: 600, clamp: false },
      { dem: polar, maxDistanceM: 150_000, clamp: true },
    ],
    0.032,
  );
  const src = stack.source(() => -1);

  it("finest product first, at the level matching the mesh spacing", () => {
    expect(src(0, 0, 100)).toBe(1000); // spacing 3.2 m → site 5 m
    expect(src(0, 0, 400)).toBe(2000); // 12.8 m → site 10 m
  });

  it("falls through to the next product past a layer's distance or pyramid", () => {
    expect(src(0, 0, 700)).toBe(10_000); // site stops at 600 m → polar L0 (22 m spacing)
    expect(src(0, 0, 100_000)).toBe(12_000); // spacing 3.2 km: polar clamped to its coarsest level
    expect(src(0, 0, 200_000)).toBe(-1); // beyond every layer → fallback (global raster)
  });
});
