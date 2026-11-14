// Named lunar features (IAU / USGS Gazetteer of Planetary Nomenclature).
// Ported from apps/moon-explorer/js/features.js. Pure module (no three.js, no DOM).
//
// Spatial index: lat/lon grid of CELL_DEG degrees. Each small feature is stored in the cell of
// its centre; a query only inspects cells within BIG_RADIUS_KM of the point. Large features
// (radius > BIG_RADIUS_KM: maria, basins…) are few and tested linearly. Cost per hover: a few
// dozen haversines instead of ~9 000.

import { haversineKm, MOON_RADIUS_KM, normalizeLon } from "./geo";

const CELL_DEG = 5;
const BIG_RADIUS_KM = 150;
const ROWS = 180 / CELL_DEG;
const COLS = 360 / CELL_DEG;

/** Contents of public/data/features.json (see scripts/build_features.py). */
export interface FeaturesJson {
  source?: string;
  generated_utc?: string;
  types?: Record<string, string>;
  /** [name, type code, diameter km, lat, lon] */
  features: [string, string, number, number, number][];
}

export interface Feature {
  name: string;
  code: string;
  type: string;
  diameterKm: number;
  radiusKm: number;
  lat: number;
  lon: number;
  key: string;
}

export interface PublicFeature {
  name: string;
  type: string;
  diameterKm: number;
  lat: number;
  lon: number;
  distanceKm: number;
}

/** Lower case without diacritics, for name search. */
export function normalizeName(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

export class FeatureIndex {
  readonly types: Record<string, string>;
  readonly features: Feature[];
  private readonly big: Feature[] = [];
  private readonly grid: Feature[][];

  constructor(json: FeaturesJson) {
    this.types = json.types ?? {};
    this.features = json.features.map(([name, code, diameterKm, lat, lon]) => ({
      name,
      code,
      type: this.types[code] ?? code,
      diameterKm,
      radiusKm: diameterKm / 2,
      lat,
      lon: normalizeLon(lon),
      key: normalizeName(name),
    }));
    this.grid = Array.from({ length: ROWS * COLS }, () => []);
    for (const f of this.features) {
      if (f.radiusKm > BIG_RADIUS_KM) this.big.push(f);
      else this.grid[this.cell(f.lat, f.lon)].push(f);
    }
  }

  private row(lat: number): number {
    return Math.min(ROWS - 1, Math.max(0, Math.floor((lat + 90) / CELL_DEG)));
  }

  private col(lon: number): number {
    return ((Math.floor((normalizeLon(lon) + 180) / CELL_DEG) % COLS) + COLS) % COLS;
  }

  private cell(lat: number, lon: number): number {
    return this.row(lat) * COLS + this.col(lon);
  }

  /**
   * Feature whose centre is closest to the point, kept only if the point lies within its radius
   * (IAU diameter / 2). Returns null otherwise.
   */
  nearest(lat: number, lon: number): (Feature & { distanceKm: number }) | null {
    let best: Feature | null = null;
    let bestD = Infinity;
    const test = (f: Feature) => {
      const d = haversineKm(lat, lon, f.lat, f.lon);
      if (d <= f.radiusKm && d < bestD) {
        bestD = d;
        best = f;
      }
    };

    for (const f of this.big) test(f);

    // Search window: BIG_RADIUS_KM in latitude…
    const dLat = (BIG_RADIUS_KM / MOON_RADIUS_KM) * (180 / Math.PI);
    const r0 = this.row(lat - dLat);
    const r1 = this.row(lat + dLat);
    // …and in longitude, widened by 1/cos(lat). Near the poles (window > 180°) all columns are
    // inspected: deterministic polar handling, no division by ~0.
    const maxAbsLat = Math.min(90, Math.abs(lat) + dLat);
    const cosLat = Math.cos((maxAbsLat * Math.PI) / 180);
    const dLon = cosLat > 1e-6 ? dLat / cosLat : Infinity;
    // One cell of margin on each side covers the small-angle approximation.
    const allCols = dLon >= 150;
    const c0 = allCols ? 0 : Math.floor((normalizeLon(lon - dLon) + 180) / CELL_DEG) - 1 + COLS;
    const span = allCols ? COLS : Math.ceil((2 * dLon) / CELL_DEG) + 3;

    for (let r = r0; r <= r1; r++) {
      for (let k = 0; k < Math.min(span, COLS); k++) {
        const c = (c0 + k) % COLS;
        for (const f of this.grid[r * COLS + c]) test(f);
      }
    }
    const found = best as Feature | null;
    return found ? { ...found, distanceKm: bestD } : null;
  }

  /** Name search: exact > prefix > word start > substring; then by size. */
  search(query: string, limit = 10): Feature[] {
    const q = normalizeName(query);
    if (!q) return [];
    const scored: [number, number, Feature][] = [];
    for (const f of this.features) {
      const i = f.key.indexOf(q);
      if (i < 0) continue;
      let score = 3;
      if (f.key === q) score = 0;
      else if (i === 0) score = 1;
      else if (f.key[i - 1] === " " || f.key[i - 1] === "-") score = 2;
      scored.push([score, -f.diameterKm, f]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return scored.slice(0, limit).map((s) => s[2]);
  }
}

/** Public (serialisable) version of a feature, for CustomEvents. */
export function publicFeature(f: (Feature & { distanceKm: number }) | null): PublicFeature | null {
  if (!f) return null;
  return { name: f.name, type: f.type, diameterKm: f.diameterKm, lat: f.lat, lon: f.lon, distanceKm: f.distanceKm };
}
