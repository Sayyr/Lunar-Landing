// Helpers to open the ground view somewhere the Sun actually lights the terrain (pure).
// Uses the rendered terrain's horizon (groundTerrain.horizonAt): a visual estimate, not the
// science service's illumination computation.

import { type GroundTerrain, horizonAt, MOON_RADIUS_M, type TerrainSource } from "./groundTerrain";
import { enuBasis, type AzEl } from "./skyGeometry";

/** Sun's angular radius seen from the Moon (degrees): "clears" = whole disc above the terrain. */
export const SUN_RADIUS_DEG = 0.27;

export function sunClearsTerrain(sun: AzEl, terrain: GroundTerrain, marginDeg = SUN_RADIUS_DEG): boolean {
  return sun.elevationDeg - horizonAt(terrain, sun.azimuthDeg) > marginDeg;
}

export interface HighGround {
  lat: number;
  lon: number;
  elevationM: number;
  distanceM: number;
}

/**
 * Highest terrain point within `radiusM` of a site (square grid of `stepM`, clipped to the
 * circle), sampled from `source` like the ground terrain. Works at the poles (local ENU grid).
 */
export function findHighGround(source: TerrainSource, latDeg: number, lonDeg: number, radiusM = 30_000, stepM = 300): HighGround | null {
  if (!source) return null;
  const elev = typeof source === "function" ? source : (la: number, lo: number) => source.sampleKmSmooth(la, lo) * 1000;
  const { east, north, up } = enuBasis(latDeg, lonDeg);
  let best: HighGround | null = null;
  const n = Math.floor(radiusM / stepM);
  for (let i = -n; i <= n; i++)
    for (let j = -n; j <= n; j++) {
      const de = i * stepM;
      const dn = j * stepM;
      const d = Math.hypot(de, dn);
      if (d > radiusM) continue;
      // Point at ground distance d along the local direction (de, dn): rotate "up" by d / R.
      const a = d / MOON_RADIUS_M;
      const ue = d ? de / d : 0;
      const un = d ? dn / d : 0;
      const v = [0, 1, 2].map((k) => Math.cos(a) * up[k] + Math.sin(a) * (ue * east[k] + un * north[k]));
      const lat = (Math.asin(Math.max(-1, Math.min(1, v[2]))) * 180) / Math.PI;
      const lon = (Math.atan2(v[1], v[0]) * 180) / Math.PI;
      const h = elev(lat, lon, d);
      if (Number.isFinite(h) && (!best || h > best.elevationM)) best = { lat, lon, elevationM: h, distanceM: d };
    }
  return best;
}
