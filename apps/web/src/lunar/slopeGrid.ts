// Slope screening of the south-polar LOLA 20 m DEM on grids of 4 km discs, precomputed offline by
// services/science/tools/slope_grid.cpp (public/data/polar_s_grid/grid_4km.json, git-ignored).
// Each disc carries a histogram of its 20 m slopes, so the share of terrain at or below any
// threshold that is a multiple of the bin width is exact, without reloading anything.
// Derived data, screening only: 20 m-baseline slope is not lander-footprint slope.

import { DATA_BASE, loadJson } from "./loaders";

export const GRID_URL = `${DATA_BASE}polar_s_grid/grid_4km.json`;

export interface SlopeGridFile {
  status: string;
  source: { product_id: string; sha256: string | null };
  method: {
    disc_diameter_m: number;
    step_m: number;
    grids: { id: number; offset_steps: [number, number]; discs: number }[];
    histogram: { bin_deg: number; bins: number };
  };
  scale_warning: string;
  columns: {
    grid: number[];
    x_km: number[];
    y_km: number[];
    lat: number[];
    lon: number[];
    valid_px: number[];
    nodata_px: number[];
    mean_deg: (number | null)[];
    max_deg: (number | null)[];
    hist: number[][];
  };
}

export interface Disc {
  index: number;
  grid: number;
  /** polar stereographic map coordinates, km; +y = image-up = toward longitude 0 */
  x: number;
  y: number;
  lat: number;
  lon: number;
  validPx: number;
  nodataPx: number;
  meanDeg: number;
  maxDeg: number;
  /** cumulative histogram: cum[k] = valid pixels with slope < k * binDeg */
  cum: Uint32Array;
}

export interface SlopeGrid {
  discs: Disc[];
  binDeg: number;
  diameterM: number;
  grids: number[];
  file: SlopeGridFile;
}

export function parseSlopeGrid(f: SlopeGridFile): SlopeGrid {
  const c = f.columns;
  const bins = f.method.histogram.bins;
  const discs = c.grid.map((grid, i) => {
    const cum = new Uint32Array(bins + 1);
    const h = c.hist[i];
    for (let k = 0; k < bins; k++) cum[k + 1] = cum[k] + (h[k] ?? 0);
    return {
      index: i,
      grid,
      x: c.x_km[i],
      y: c.y_km[i],
      lat: c.lat[i],
      lon: c.lon[i],
      validPx: c.valid_px[i],
      nodataPx: c.nodata_px[i],
      meanDeg: c.mean_deg[i] ?? NaN,
      maxDeg: c.max_deg[i] ?? NaN,
      cum,
    };
  });
  return {
    discs,
    binDeg: f.method.histogram.bin_deg,
    diameterM: f.method.disc_diameter_m,
    grids: f.method.grids.map((g) => g.id),
    file: f,
  };
}

let promise: Promise<SlopeGrid | null> | null = null;
/** The grid file, or null when it is not installed. */
export function loadSlopeGrid(): Promise<SlopeGrid | null> {
  return (promise ??= loadJson<SlopeGridFile>(GRID_URL)
    .then(parseSlopeGrid)
    .catch(() => null));
}

/**
 * Share of the disc's valid pixels with slope ≤ maxDeg, NaN without valid pixels. Exact when maxDeg
 * is a multiple of binDeg; otherwise rounded DOWN to the bin edge (conservative: never counts a
 * steeper pixel as acceptable). Bin b holds [b·bin, (b+1)·bin), so "≤ t" uses bins below t/bin —
 * a pixel at exactly t falls in the next bin and is counted as steeper (measure-zero difference).
 */
export function fractionAtMost(d: Disc, maxDeg: number, binDeg: number): number {
  if (d.validPx === 0) return NaN;
  const k = Math.min(d.cum.length - 1, Math.max(0, Math.floor(maxDeg / binDeg + 1e-9)));
  return d.cum[k] / d.validPx;
}

/** Red (≤ 50 %) → amber (75 %) → green (100 %), as an [r, g, b] triple 0–255; grey for NaN. */
export function fractionColour(f: number): [number, number, number] {
  if (!Number.isFinite(f)) return [110, 110, 110];
  const t = Math.min(1, Math.max(0, (f - 0.5) / 0.5));
  const red: [number, number, number] = [229, 83, 75];
  const amber: [number, number, number] = [242, 193, 78];
  const green: [number, number, number] = [47, 200, 90];
  const [a, b, u] = t < 0.5 ? [red, amber, t / 0.5] : [amber, green, (t - 0.5) / 0.5];
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * u)) as [number, number, number];
}

/** Best discs first: higher share ≤ threshold, then lower mean slope, then lower index. */
export function rankDiscs(discs: readonly Disc[], maxDeg: number, binDeg: number, limit: number): { disc: Disc; fraction: number }[] {
  return discs
    .map((disc) => ({ disc, fraction: fractionAtMost(disc, maxDeg, binDeg) }))
    .filter((r) => Number.isFinite(r.fraction))
    .sort((a, b) => b.fraction - a.fraction || a.disc.meanDeg - b.disc.meanDeg || a.disc.index - b.disc.index)
    .slice(0, limit);
}
