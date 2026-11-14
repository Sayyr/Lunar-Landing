// Terrain around an observer standing at a lunar site, for the first-person ground view (pure).
//
// Polar grid centred on the site: rings at geometric distances (5 m … 400 km) × bearings, every
// vertex placed on the REAL curved surface (reference sphere 1737.4 km + LOLA elevation), then
// expressed in the observer's local frame. So the drawn horizon includes curvature and distant
// relief, at the LOLA raster's resolution (≈ 1.9 km/px for ldem_16: near-field detail is smooth).
// Visualization of the DEM, not the computed terrain horizon (that is the science service's job).
//
// Output frame: metres, origin at the observer's eye, three.js axes x = East, y = Up, z = −North.
// Directions are built from the ENU basis (enuBasis), so the poles work (prime-meridian fallback).

import { DEG, MOON_RADIUS_KM } from "../lib/constants";
import type { Heightmap } from "./heightmap";
import { enuBasis, wrap360 } from "./skyGeometry";

export const MOON_RADIUS_M = MOON_RADIUS_KM * 1000;
/** Repeat length of the (illustrative) regolith detail texture at its finest scale, metres. */
export const DETAIL_PERIOD_M = 4;

/** Writes the ground colour at a lat/lon, RGB in 0..1, into out[offset … offset + 2]. */
export type ColorSource = (latDeg: number, lonDeg: number, out: Float32Array, offset: number) => void;

export interface GroundTerrainOptions {
  bearings: number;
  rings: number;
  minDistanceM: number;
  maxDistanceM: number;
}

export const DEFAULT_GROUND: GroundTerrainOptions = { bearings: 900, rings: 360, minDistanceM: 5, maxDistanceM: 400_000 };

/**
 * Radial gap between consecutive rings per metre of distance (rings are geometric): the terrain
 * is sampled every d × this, so data finer than that is wasted (and aliases).
 */
export const ringSpacingPerMetre = (opt: GroundTerrainOptions = DEFAULT_GROUND) =>
  (opt.maxDistanceM / opt.minDistanceM) ** (1 / (opt.rings - 1)) - 1;

/** Elevation (metres, relative to 1737.4 km) at a lat/lon, `distanceM` from the observer. */
export type TerrainSource = (latDeg: number, lonDeg: number, distanceM: number) => number;

/** The global raster (bicubic: continuous slopes, no pixel-edge shading), or a smooth sphere. */
export const heightmapSource =
  (hm: Heightmap | null): TerrainSource =>
  (lat, lon) =>
    hm ? hm.sampleKmSmooth(lat, lon) * 1000 : 0;

export interface GroundTerrain {
  /** xyz per vertex (metres, eye at the origin); vertex 0 = point under the observer */
  positions: Float32Array;
  /** shared between builds with the same bearings × rings: do not modify */
  indices: Uint32Array;
  /** surface elevation under the observer, metres relative to 1737.4 km */
  siteElevationM: number;
  /** Detail-texture coordinates: local metres / DETAIL_PERIOD_M (x = East, y = North). */
  uvs: Float32Array;
  /** Optional per-vertex RGB (0..1) from a colour map; undefined without one. */
  colors?: Float32Array;
  /**
   * Terrain horizon of the BUILT mesh, degrees per bearing (index j ↔ j·360/bearings° from north):
   * highest elevation angle of any vertex in that direction. A visual estimate at mesh sampling,
   * not the science service's DEM horizon.
   */
  horizonDeg: Float32Array;
}

/** Terrain horizon (degrees) in the direction `azimuthDeg`, linear between mesh bearings. */
export function horizonAt(t: GroundTerrain, azimuthDeg: number): number {
  const B = t.horizonDeg.length;
  const x = (wrap360(azimuthDeg) / 360) * B;
  const j = Math.floor(x) % B;
  const f = x - Math.floor(x);
  return t.horizonDeg[j] * (1 - f) + t.horizonDeg[(j + 1) % B] * f;
}

export function buildGroundTerrain(
  source: TerrainSource,
  latDeg: number,
  lonDeg: number,
  observerHeightM: number,
  opt: GroundTerrainOptions = DEFAULT_GROUND,
  color?: ColorSource,
): GroundTerrain {
  const { east, north, up } = enuBasis(latDeg, lonDeg);
  const siteElevationM = source(latDeg, lonDeg, 0);
  const eyeR = MOON_RADIUS_M + siteElevationM + observerHeightM;

  const B = opt.bearings;
  const N = opt.rings;
  const horizonDeg = new Float32Array(B).fill(-90);
  const positions = new Float32Array((1 + N * B) * 3);
  const uvs = new Float32Array((1 + N * B) * 2);
  const colors = color ? new Float32Array((1 + N * B) * 3) : undefined;
  if (colors && color) color(latDeg, lonDeg, colors, 0);
  // Vertex 0: ground point under the eye.
  positions[1] = -observerHeightM;

  // Horizontal unit direction of each bearing (clockwise from north), same for every ring.
  const horiz = new Float64Array(3 * B);
  for (let j = 0; j < B; j++) {
    const b = (j / B) * 2 * Math.PI;
    for (let k = 0; k < 3; k++) horiz[3 * j + k] = Math.cos(b) * north[k] + Math.sin(b) * east[k];
  }

  const ratio = (opt.maxDistanceM / opt.minDistanceM) ** (1 / (N - 1));
  for (let i = 0; i < N; i++) {
    const dist = opt.minDistanceM * ratio ** i;
    const delta = dist / MOON_RADIUS_M; // central angle
    const cd = Math.cos(delta);
    const sd = Math.sin(delta);
    for (let j = 0; j < B; j++) {
      const dx = cd * up[0] + sd * horiz[3 * j];
      const dy = cd * up[1] + sd * horiz[3 * j + 1];
      const dz = cd * up[2] + sd * horiz[3 * j + 2];
      const lat = Math.asin(Math.max(-1, Math.min(1, dz))) / DEG;
      const lon = Math.atan2(dy, dx) / DEG;
      const r = MOON_RADIUS_M + source(lat, lon, dist);
      // Position relative to the eye, in ENU (eye = eyeR · up).
      const px = dx * r - up[0] * eyeR;
      const py = dy * r - up[1] * eyeR;
      const pz = dz * r - up[2] * eyeR;
      const e = px * east[0] + py * east[1] + pz * east[2];
      const n = px * north[0] + py * north[1] + pz * north[2];
      const u = px * up[0] + py * up[1] + pz * up[2];
      const v = 1 + i * B + j;
      positions[3 * v] = e;
      positions[3 * v + 1] = u;
      positions[3 * v + 2] = -n;
      uvs[2 * v] = e / DETAIL_PERIOD_M;
      uvs[2 * v + 1] = n / DETAIL_PERIOD_M;
      if (colors && color) color(lat, lon, colors, 3 * v);
      const elev = Math.atan2(u, Math.hypot(e, n)) / DEG;
      if (elev > horizonDeg[j]) horizonDeg[j] = elev;
    }
  }
  return { positions, indices: gridIndices(B, N), siteElevationM, horizonDeg, uvs, colors };
}

/** Triangle indices depend only on bearings × rings: built once per shape. */
const indexCache = new Map<string, Uint32Array>();
function gridIndices(B: number, N: number): Uint32Array {
  const key = `${B}x${N}`;
  let idx = indexCache.get(key);
  if (idx) return idx;
  idx = new Uint32Array(3 * B + 6 * B * (N - 1));
  let o = 0;
  // Counter-clockwise seen from above (+y): centre → next bearing → this bearing.
  for (let j = 0; j < B; j++) {
    idx[o++] = 0;
    idx[o++] = 1 + ((j + 1) % B);
    idx[o++] = 1 + j;
  }
  for (let i = 0; i < N - 1; i++)
    for (let j = 0; j < B; j++) {
      const a = 1 + i * B + j;
      const b = 1 + i * B + ((j + 1) % B);
      idx.set([a, b, a + B, b, b + B, a + B], o);
      o += 6;
    }
  indexCache.set(key, idx);
  return idx;
}
