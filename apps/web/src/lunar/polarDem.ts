// High-resolution polar DEM (LOLA LDEM_85S_20M, 20 m/px, MOON_ME DE421) tiled by
// scripts/tile_polar_dem.py, sampled around one site for the ground view.
//
// Projection: spherical polar stereographic, as recorded in manifest.json (signs validated by the
// tiler against ldem_16: median |Δh| ≈ 28 m at 4000 random points). Units: km relative to a
// 1737.4 km sphere, same reference as ldem_16, so the two join without offset.

export interface PolarManifest {
  source: string;
  frame: string;
  projection: {
    center_lat: number;
    center_lon: number;
    radius_m: number;
    line_off: number;
    sample_off: number;
    scale_m: number;
    sign_y: number;
    sign_line: number;
  };
  tile: number;
  levels: { level: number; scale_m: number; lines: number; samples: number; rows: number; cols: number }[];
  validation: { median_abs_km: number; rms_km: number };
}

const DEG = Math.PI / 180;
const NODATA = 65535;

/** Level-0 fractional pixel coordinates (0-based pixel centres) of a lat/lon. */
export function polarPixel(m: PolarManifest, latDeg: number, lonDeg: number): { line: number; sample: number } {
  const p = m.projection;
  const south = p.center_lat < 0;
  const phi = latDeg * DEG;
  const k = 2 * p.radius_m * (south ? Math.tan(Math.PI / 4 + phi / 2) : Math.tan(Math.PI / 4 - phi / 2));
  const dl = (lonDeg - p.center_lon) * DEG;
  const x = k * Math.sin(dl);
  const y = p.sign_y * k * Math.cos(dl);
  return { line: p.line_off + (p.sign_line * y) / p.scale_m, sample: p.sample_off + x / p.scale_m };
}

/** Level-n pixel coordinate from a level-0 one (each level halves the resolution, 2×2 means). */
export const toLevel = (i0: number, level: number) => (i0 + 0.5) / 2 ** level - 0.5;

interface Tile {
  offset: number;
  step: number;
  values: Uint16Array;
}

export class PolarDem {
  // Numeric key (level, row, col) → tile; null = missing/failed. Numeric keys keep the 16 look-ups
  // per bicubic sample cheap (hundreds of thousands of samples per terrain build).
  private readonly tiles = new Map<number, Tile | null>();
  private static key = (level: number, row: number, col: number) => (level * 4096 + row) * 4096 + col;
  constructor(
    readonly manifest: PolarManifest,
    private readonly base: string,
  ) {}

  /** True when the point is inside the product's square (level 0). */
  covers(latDeg: number, lonDeg: number): boolean {
    const L = this.manifest.levels[0];
    const { line, sample } = polarPixel(this.manifest, latDeg, lonDeg);
    return line >= 1 && sample >= 1 && line <= L.lines - 3 && sample <= L.samples - 3;
  }

  /**
   * Loads every tile needed to sample within `radiusM` of the site at each given level.
   * `onProgress(done, total)` after each tile. Already-loaded tiles are not fetched again.
   */
  async loadAround(
    latDeg: number,
    lonDeg: number,
    plan: { level: number; radiusM: number }[],
    onProgress?: (done: number, total: number) => void,
    concurrency = 6,
  ): Promise<void> {
    const { line, sample } = polarPixel(this.manifest, latDeg, lonDeg);
    const T = this.manifest.tile;
    const keys: string[] = [];
    for (const { level, radiusM } of plan) {
      const L = this.manifest.levels[level];
      if (!L) continue;
      const r = radiusM / L.scale_m + 3; // + bicubic margin
      const l = toLevel(line, level);
      const s = toLevel(sample, level);
      for (let row = Math.max(0, Math.floor((l - r) / T)); row <= Math.min(L.rows - 1, Math.floor((l + r) / T)); row++)
        for (let col = Math.max(0, Math.floor((s - r) / T)); col <= Math.min(L.cols - 1, Math.floor((s + r) / T)); col++) {
          if (!this.tiles.has(PolarDem.key(level, row, col))) keys.push(`${level}/${row}_${col}`);
        }
    }
    let done = 0;
    let next = 0;
    onProgress?.(0, keys.length);
    const worker = async () => {
      while (next < keys.length) {
        const k = keys[next++];
        const [lv, rc] = k.split("/");
        const [row, col] = rc.split("_").map(Number);
        const nk = PolarDem.key(Number(lv), row, col);
        try {
          const res = await fetch(`${this.base}L${lv}/${rc}.u16`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          if (buf.byteLength !== 8 + T * T * 2) throw new Error("unexpected size");
          const head = new DataView(buf, 0, 8);
          this.tiles.set(nk, { offset: head.getFloat32(0, true), step: head.getFloat32(4, true), values: new Uint16Array(buf, 8) });
        } catch {
          this.tiles.set(nk, null); // e.g. a tile outside the data (not written by the tiler)
        }
        onProgress?.(++done, keys.length);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  /** Height (km) of one level pixel, NaN if missing / no data / not loaded. */
  private pixel(level: number, line: number, sample: number): number {
    const T = this.manifest.tile;
    const t = this.tiles.get(PolarDem.key(level, Math.floor(line / T), Math.floor(sample / T)));
    if (!t) return NaN;
    const v = t.values[(line % T) * T + (sample % T)];
    return v === NODATA ? NaN : t.offset + v * t.step;
  }

  /**
   * Elevation (km) by bicubic Catmull-Rom interpolation at `level` (smooth slopes: no stair-step
   * shading at 20 m). NaN outside the product or where a tile is not loaded.
   */
  sampleKm(latDeg: number, lonDeg: number, level: number): number {
    const L = this.manifest.levels[level];
    if (!L) return NaN;
    const p0 = polarPixel(this.manifest, latDeg, lonDeg);
    const l = toLevel(p0.line, level);
    const s = toLevel(p0.sample, level);
    const l1 = Math.floor(l);
    const s1 = Math.floor(s);
    if (l1 < 1 || s1 < 1 || l1 > L.lines - 3 || s1 > L.samples - 3) return NaN;
    const tl = l - l1;
    const ts = s - s1;
    const cr = (a: number, b: number, c: number, d: number, t: number) =>
      b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
    const row = (dl: number) =>
      cr(this.pixel(level, l1 + dl, s1 - 1), this.pixel(level, l1 + dl, s1), this.pixel(level, l1 + dl, s1 + 1), this.pixel(level, l1 + dl, s1 + 2), ts);
    return cr(row(-1), row(0), row(1), row(2), tl);
  }

  get tileCount(): number {
    return [...this.tiles.values()].filter(Boolean).length;
  }
}

/** Resolution plan around a site: finest data near the observer, coarser further out. */
export const POLAR_PLAN = [
  { level: 0, radiusM: 6_000 },
  { level: 1, radiusM: 25_000 },
  { level: 2, radiusM: 80_000 },
  { level: 3, radiusM: 150_000 },
];

/** Level to use for a terrain vertex at `distanceM` from the observer (−1 = beyond the plan). */
export function polarLevelFor(distanceM: number): number {
  for (const p of POLAR_PLAN) if (distanceM <= p.radiusM) return p.level;
  return -1;
}
