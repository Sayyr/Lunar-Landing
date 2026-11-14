// Coarse terrain slope from the global LOLA display raster (ldem_4 / ldem_16, equirectangular,
// 7.6 / 1.9 km per pixel at the equator). Used by the slope scope OUTSIDE the 20 m polar product.
//
// Horn (1981) 3×3 on the lat/lon grid with true ground spacings on the 1737.4 km sphere:
// dx = R·cos(lat)·Δλ (east), dy = R·Δφ (north). A km-scale baseline smooths terrain heavily: these
// slopes are much LOWER than 20 m-baseline slopes and are NOT comparable to them — overview only.
// Visualization of the displayed raster, not a science-service result.

import { DEG } from "../lib/constants";
import { MOON_RADIUS_KM } from "./geo";
import type { Heightmap } from "./heightmap";

/** Rows within this many degrees of a pole are no-data (equirectangular cells degenerate there). */
export const COARSE_POLE_EXCLUSION_DEG = 1;

/**
 * Slope (degrees) of the raster cell containing (lat, lon), NaN at the poles' degenerate rows or
 * when a neighbour is not finite. Row 0 = south, column 0 = west edge at −180°, area pixels.
 */
export function coarseSlopeDeg(hm: Heightmap, lat: number, lon: number): number {
  const { width: W, height: H, data } = hm;
  const col = Math.floor(((lon + 180) / 360) * W);
  const row = Math.floor(((lat + 90) / 180) * H);
  if (row < 1 || row > H - 2) return NaN;
  const rowLat = -90 + ((row + 0.5) * 180) / H;
  if (Math.abs(rowLat) > 90 - COARSE_POLE_EXCLUSION_DEG) return NaN;
  const c = (dc: number) => (((col + dc) % W) + W) % W;
  const z = (dr: number, dc: number) => data[(row + dr) * W + c(dc)] * 1000; // m
  const a = z(1, -1), b = z(1, 0), cc = z(1, 1); // north row (row + 1 = further north)
  const d = z(0, -1), f = z(0, 1);
  const g = z(-1, -1), h = z(-1, 0), i = z(-1, 1);
  if (![a, b, cc, d, f, g, h, i].every(Number.isFinite)) return NaN;
  const dyM = (MOON_RADIUS_KM * 1000 * Math.PI) / H;
  const dxM = ((MOON_RADIUS_KM * 1000 * 2 * Math.PI) / W) * Math.cos(rowLat * DEG);
  const dzdx = (cc + 2 * f + i - (a + 2 * d + g)) / (8 * dxM); // east
  const dzdy = (a + 2 * b + cc - (g + 2 * h + i)) / (8 * dyM); // north
  return Math.atan(Math.hypot(dzdx, dzdy)) / DEG;
}
