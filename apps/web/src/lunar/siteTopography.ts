// Terrain summary around a point from the global LOLA display raster (ldem_16: 1.9 km/px at the
// equator; ldem_4 fallback: 7.6 km/px). Used by the "Landing sites" page.
//
// Everything here is a km-scale OVERVIEW of the displayed raster, not a science-service result:
//  * heights are km relative to the 1737.4 km sphere (LOLA convention), reported in metres;
//  * slopes are Horn 3x3 on the raster grid (coarseSlope.ts): a ~2 km baseline smooths terrain, so
//    they are far lower than 20 m-baseline or lander-footprint slopes and must not be read as such;
//  * the shaded relief uses a conventional cartographic light (from the north-west, 45° high), not
//    the real Sun.

import { DEG } from "../lib/constants";
import { coarseSlopeDeg } from "./coarseSlope";
import { haversineKm, MOON_RADIUS_KM } from "./geo";
import type { Heightmap } from "./heightmap";

export type PoleBand = "polar" | "high" | "mid" | "equatorial";

export interface PoleProximity {
  pole: "south" | "north";
  /** Great-circle distance to that pole on the 1737.4 km sphere. */
  distanceKm: number;
  band: PoleBand;
}

/**
 * Display classes by |latitude| (SELENE's own thresholds, not an official definition):
 * polar ≥ 80°, high latitude 60–80°, mid latitude 30–60°, equatorial < 30°.
 * Latitude 0 counts as southern (tie broken deterministically).
 */
export const POLE_BANDS: readonly { band: PoleBand; minAbsLat: number; label: string }[] = [
  { band: "polar", minAbsLat: 80, label: "Polar (|lat| ≥ 80°)" },
  { band: "high", minAbsLat: 60, label: "High latitude (60–80°)" },
  { band: "mid", minAbsLat: 30, label: "Mid latitude (30–60°)" },
  { band: "equatorial", minAbsLat: 0, label: "Equatorial (< 30°)" },
];

export function poleProximity(lat: number): PoleProximity {
  const pole = lat > 0 ? "north" : "south";
  const a = Math.abs(lat);
  const band = POLE_BANDS.find((b) => a >= b.minAbsLat)!.band;
  return { pole, distanceKm: (90 - a) * DEG * MOON_RADIUS_KM, band };
}

export interface Topography {
  /** Raster product name, e.g. "ldem_16". */
  product: string;
  kmPerPixel: number;
  /** Bilinear height at the site, metres above the 1737.4 km sphere. */
  elevationM: number;
  /** Horn slope of the raster cell containing the site, degrees (NaN near the poles). */
  slopeDeg: number;
  radiusKm: number;
  /** Over the raster cells whose centre is within radiusKm of the site. */
  minM: number;
  maxM: number;
  reliefM: number;
  meanSlopeDeg: number;
  maxSlopeDeg: number;
  cells: number;
  /** slopes of those cells (finite ones only), degrees */
  cellSlopesDeg: Float32Array;
}

/** Terrain statistics within radiusKm of (lat, lon). Null when no finite cell is found. */
export function analyseTopography(hm: Heightmap, lat: number, lon: number, radiusKm = 15): Topography | null {
  const { width: W, height: H, data } = hm;
  const cellDeg = 180 / H;
  const dLat = (radiusKm / MOON_RADIUS_KM) / DEG;
  const rowLo = Math.max(0, Math.floor((lat - dLat + 90) / cellDeg));
  const rowHi = Math.min(H - 1, Math.floor((lat + dLat + 90) / cellDeg));
  let min = Infinity, max = -Infinity, sSum = 0, sMax = -Infinity, sN = 0, n = 0;
  const slopes: number[] = [];
  for (let r = rowLo; r <= rowHi; r++) {
    const rLat = -90 + (r + 0.5) * cellDeg;
    const c = Math.cos(rLat * DEG);
    const dLon = c > 1e-6 ? Math.min(180, dLat / c) : 180;
    const colLo = Math.floor(((lon - dLon + 180) / 360) * W);
    const colHi = Math.floor(((lon + dLon + 180) / 360) * W);
    for (let k = colLo; k <= colHi; k++) {
      const col = ((k % W) + W) % W;
      const cLon = -180 + (col + 0.5) * (360 / W);
      if (haversineKm(lat, lon, rLat, cLon) > radiusKm) continue;
      const h = data[r * W + col] * 1000;
      if (!Number.isFinite(h)) continue;
      n++;
      if (h < min) min = h;
      if (h > max) max = h;
      const s = coarseSlopeDeg(hm, rLat, cLon);
      if (Number.isFinite(s)) {
        sSum += s;
        sN++;
        slopes.push(s);
        if (s > sMax) sMax = s;
      }
    }
  }
  const elevationM = hm.sampleKm(lat, lon) * 1000;
  if (n === 0 || !Number.isFinite(elevationM)) return null;
  return {
    product: hm.label,
    kmPerPixel: hm.kmPerPixel,
    elevationM,
    slopeDeg: coarseSlopeDeg(hm, lat, lon),
    radiusKm,
    minM: min,
    maxM: max,
    reliefM: max - min,
    meanSlopeDeg: sN ? sSum / sN : NaN,
    maxSlopeDeg: sN ? sMax : NaN,
    cells: n,
    cellSlopesDeg: Float32Array.from(slopes),
  };
}

/** Local east/north offset (km) → lat/lon on the sphere (azimuthal equidistant about the site). */
export function offsetLatLon(lat0: number, lon0: number, eastKm: number, northKm: number): { lat: number; lon: number } {
  const d = Math.hypot(eastKm, northKm) / MOON_RADIUS_KM; // angular distance, rad
  if (d === 0) return { lat: lat0, lon: lon0 };
  const az = Math.atan2(eastKm, northKm); // from north toward east
  const p0 = lat0 * DEG;
  const p = Math.asin(Math.sin(p0) * Math.cos(d) + Math.cos(p0) * Math.sin(d) * Math.cos(az));
  const l = lon0 * DEG + Math.atan2(Math.sin(az) * Math.sin(d) * Math.cos(p0), Math.cos(d) - Math.sin(p0) * Math.sin(p));
  const lonDeg = ((((l / DEG + 180) % 360) + 360) % 360) - 180;
  return { lat: p / DEG, lon: lonDeg };
}

export interface ReliefGrid {
  size: number;
  /** Lambert shading in [0, 1] (light from azimuth 315°, elevation 45°), NaN without data */
  shade: Float32Array;
  /** height within the crop, 0 = lowest, 1 = highest */
  height01: Float32Array;
  /** Horn slope of the raster cell under each pixel (coarseSlopeDeg), degrees, NaN without data */
  slopeDeg: Float32Array;
}

/** Shading, relative height and raster slope on a size × size grid covering ±halfKm east/north (north up). */
export function reliefGrid(hm: Heightmap, lat: number, lon: number, halfKm: number, size: number): ReliefGrid {
  const N = size + 2;
  const h = new Float64Array(N * N);
  const slopeDeg = new Float32Array(size * size);
  const stepKm = (2 * halfKm) / size;
  let lo = Infinity, hi = -Infinity;
  for (let j = -1; j <= size; j++)
    for (let i = -1; i <= size; i++) {
      const p = offsetLatLon(lat, lon, -halfKm + (i + 0.5) * stepKm, halfKm - (j + 0.5) * stepKm);
      const v = hm.sampleKmSmooth(p.lat, p.lon) * 1000;
      h[(j + 1) * N + (i + 1)] = v;
      if (i >= 0 && j >= 0 && i < size && j < size) {
        slopeDeg[j * size + i] = coarseSlopeDeg(hm, p.lat, p.lon);
        if (Number.isFinite(v)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
  const shade = new Float32Array(size * size);
  const height01 = new Float32Array(size * size);
  const L = { x: -0.5, y: 0.5, z: Math.SQRT1_2 }; // toward the light: az 315°, el 45° (east, north, up)
  const at = (i: number, j: number) => h[(j + 1) * N + (i + 1)];
  const stepM = stepKm * 1000;
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const v = at(i, j);
      const dzdx = (at(i + 1, j) - at(i - 1, j)) / (2 * stepM); // east
      const dzdy = (at(i, j - 1) - at(i, j + 1)) / (2 * stepM); // north (row j-1 is further north)
      if (![v, dzdx, dzdy].every(Number.isFinite)) {
        shade[k] = height01[k] = NaN;
        continue;
      }
      shade[k] = Math.max(0, (-dzdx * L.x - dzdy * L.y + L.z) / Math.hypot(dzdx, dzdy, 1));
      height01[k] = hi > lo ? (v - lo) / (hi - lo) : 0.5;
    }
  return { size, shade, height01, slopeDeg };
}

const GREEN = [0.1, 0.85, 0.4];
const RED = [0.95, 0.25, 0.2];
const NODATA = [0.45, 0.45, 0.45];

/**
 * RGBA image of a relief grid. maxSlopeDeg null: grey shading tinted by height. Otherwise the
 * slope scope's convention (slopeOverlay.ts): green where the raster slope ≤ maxSlopeDeg, red where
 * steeper, grey where the slope is undefined — modulated by the shading so the relief stays readable.
 */
export function colourRelief(g: ReliefGrid, maxSlopeDeg: number | null): Uint8ClampedArray {
  const out = new Uint8ClampedArray(g.size * g.size * 4);
  for (let k = 0; k < g.size * g.size; k++) {
    const o = k * 4;
    out[o + 3] = 255;
    const sh = g.shade[k];
    if (!Number.isFinite(sh)) continue;
    const lum = 0.25 + 0.75 * sh;
    if (maxSlopeDeg == null) {
      const t = g.height01[k];
      const v = 40 + 200 * sh;
      out[o] = v * (0.8 + 0.3 * t);
      out[o + 1] = v * 0.95;
      out[o + 2] = v * (1.1 - 0.3 * t);
    } else {
      const s = g.slopeDeg[k];
      const c = !Number.isFinite(s) ? NODATA : s <= maxSlopeDeg ? GREEN : RED;
      out[o] = 255 * c[0] * lum;
      out[o + 1] = 255 * c[1] * lum;
      out[o + 2] = 255 * c[2] * lum;
    }
  }
  return out;
}

/** Grey shaded relief tinted by height (no slope classes). */
export function shadedRelief(hm: Heightmap, lat: number, lon: number, halfKm: number, size: number): Uint8ClampedArray {
  return colourRelief(reliefGrid(hm, lat, lon, halfKm, size), null);
}

/** Fraction of finite slopes ≤ maxDeg (NaN when there is none). */
export function fractionAtMost(slopes: ArrayLike<number>, maxDeg: number): number {
  let ok = 0, n = 0;
  for (let i = 0; i < slopes.length; i++) {
    const s = slopes[i];
    if (!Number.isFinite(s)) continue;
    n++;
    if (s <= maxDeg) ok++;
  }
  return n ? ok / n : NaN;
}
