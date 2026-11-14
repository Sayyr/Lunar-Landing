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

import type { Heightmap } from "./heightmap";
import { enuBasis, type Vec3 } from "./skyGeometry";

export const MOON_RADIUS_M = 1_737_400;

export interface GroundTerrainOptions {
  bearings: number;
  rings: number;
  minDistanceM: number;
  maxDistanceM: number;
}

export const DEFAULT_GROUND: GroundTerrainOptions = { bearings: 1080, rings: 220, minDistanceM: 5, maxDistanceM: 400_000 };

/**
 * Where elevations come from: the global raster (bicubic), nothing (smooth sphere), or a custom
 * function of (lat, lon, distance from the observer in metres) → metres, e.g. a high-resolution
 * polar DEM near the site with the global raster as fallback.
 */
export type TerrainSource = Heightmap | null | ((latDeg: number, lonDeg: number, distanceM: number) => number);

export interface GroundTerrain {
  /** xyz per vertex (metres, eye at the origin); vertex 0 = point under the observer */
  positions: Float32Array;
  indices: Uint32Array;
  /** surface elevation under the observer, metres relative to 1737.4 km (0 without raster) */
  siteElevationM: number;
  observerHeightM: number;
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
  const x = ((((azimuthDeg % 360) + 360) % 360) / 360) * B;
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
): GroundTerrain {
  const { east, north, up } = enuBasis(latDeg, lonDeg);
  // Bicubic: continuous slopes, so the shading does not show the raster's pixel edges.
  const elevM: (lat: number, lon: number, d: number) => number =
    typeof source === "function" ? source : source ? (lat, lon) => source.sampleKmSmooth(lat, lon) * 1000 : () => 0;
  const siteElevationM = elevM(latDeg, lonDeg, 0);
  const eyeR = MOON_RADIUS_M + siteElevationM + observerHeightM;

  const B = opt.bearings;
  const N = opt.rings;
  const horizonDeg = new Float32Array(B).fill(-90);
  const positions = new Float32Array((1 + N * B) * 3);
  // Vertex 0: ground point under the eye.
  positions[1] = -observerHeightM;

  const ratio = (opt.maxDistanceM / opt.minDistanceM) ** (1 / (N - 1));
  const dir: Vec3 = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const dist = opt.minDistanceM * ratio ** i;
    const delta = dist / MOON_RADIUS_M; // central angle
    const cd = Math.cos(delta);
    const sd = Math.sin(delta);
    for (let j = 0; j < B; j++) {
      const b = (j / B) * 2 * Math.PI; // bearing, clockwise from north
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      for (let k = 0; k < 3; k++) dir[k] = cd * up[k] + sd * (cb * north[k] + sb * east[k]);
      const lat = (Math.asin(Math.max(-1, Math.min(1, dir[2]))) * 180) / Math.PI;
      const lon = (Math.atan2(dir[1], dir[0]) * 180) / Math.PI;
      const r = MOON_RADIUS_M + elevM(lat, lon, dist);
      // Position relative to the eye, in ENU (eye = eyeR · up).
      const px = dir[0] * r - up[0] * eyeR;
      const py = dir[1] * r - up[1] * eyeR;
      const pz = dir[2] * r - up[2] * eyeR;
      const e = px * east[0] + py * east[1] + pz * east[2];
      const n = px * north[0] + py * north[1] + pz * north[2];
      const u = px * up[0] + py * up[1] + pz * up[2];
      const v = 1 + i * B + j;
      positions[3 * v] = e;
      positions[3 * v + 1] = u;
      positions[3 * v + 2] = -n;
      const elev = (Math.atan2(u, Math.hypot(e, n)) * 180) / Math.PI;
      if (elev > horizonDeg[j]) horizonDeg[j] = elev;
    }
  }

  const tris: number[] = [];
  // Counter-clockwise seen from above (+y): centre → next bearing → this bearing.
  for (let j = 0; j < B; j++) tris.push(0, 1 + ((j + 1) % B), 1 + j);
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < B; j++) {
      const a = 1 + i * B + j;
      const b2 = 1 + i * B + ((j + 1) % B);
      const c = a + B;
      const d = b2 + B;
      tris.push(a, b2, c, b2, d, c);
    }
  }
  return { positions, indices: Uint32Array.from(tris), siteElevationM, observerHeightM, horizonDeg };
}

/** Elevation angle (degrees) of a terrain vertex seen from the eye. */
export function vertexElevationDeg(t: GroundTerrain, v: number): number {
  const x = t.positions[3 * v];
  const y = t.positions[3 * v + 1];
  const z = t.positions[3 * v + 2];
  return (Math.atan2(y, Math.hypot(x, z)) * 180) / Math.PI;
}
