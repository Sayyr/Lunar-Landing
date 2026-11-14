// Sun / Earth directions as seen from the Moon, and their local azimuth/elevation at a site.
// VISUALIZATION of the celestial state (today the SYNTHETIC mock, later the backend): no new
// ephemeris maths here, only frame rotations.
//
// Frames:
//   - input: CelestialStateResponse vectors (ecliptic of date, metres) and `moon_orientation`
//     (row-major 3×3, Moon body-fixed → ecliptic of date);
//   - output "body": Moon body-fixed, +X = lon 0°, +Y = lon 90° E, +Z = north pole (unit vectors).
// Directions are from the Moon's CENTRE: topocentric parallax (≤ 0.26° for Earth, negligible for
// the Sun) is ignored.

import type { CelestialStateResponse } from "../api/celestialTypes";
import { DEG } from "../lib/constants";

export type Vec3 = [number, number, number];

export interface MoonSky {
  /** Moon centre → Sun, body frame, unit */
  sun: Vec3;
  /** Moon centre → Earth centre, body frame, unit */
  earth: Vec3;
  /** Earth body-fixed → Moon body-fixed, row-major 3×3 (texture orientation only) */
  earthToBody: number[];
}

const unit = (v: Vec3): Vec3 => {
  const r = Math.hypot(v[0], v[1], v[2]);
  if (r === 0) throw new Error("zero vector has no direction");
  return [v[0] / r, v[1] / r, v[2] / r];
};
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Mᵀ·v for a row-major 3×3 rotation M (ecliptic → body when M is body → ecliptic). */
function transposeApply(m: number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

export function moonSky(state: CelestialStateResponse): MoonSky {
  const M = state.moon_orientation;
  const moon = state.moon_from_earth.position_m; // Earth → Moon
  const sun = state.sun_from_earth.position_m; // Earth → Sun
  const toEarth: Vec3 = [-moon[0], -moon[1], -moon[2]];
  const toSun: Vec3 = [sun[0] - moon[0], sun[1] - moon[1], sun[2] - moon[2]];
  // Mᵀ_moon · M_earth : Earth body → ecliptic → Moon body.
  const E = state.earth_orientation;
  const earthToBody: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) earthToBody.push(M[r] * E[c] + M[3 + r] * E[3 + c] + M[6 + r] * E[6 + c]);
  return { sun: unit(transposeApply(M, toSun)), earth: unit(transposeApply(M, toEarth)), earthToBody };
}

export interface AzEl {
  /** clockwise from local north, degrees in [0, 360) */
  azimuthDeg: number;
  /** above the local tangent plane of the reference sphere, degrees */
  elevationDeg: number;
}

/** Angle in degrees wrapped to [0, 360). */
export const wrap360 = (deg: number) => ((deg % 360) + 360) % 360;

interface EnuBasis {
  east: Vec3;
  north: Vec3;
  up: Vec3;
}

/**
 * Local East/North/Up unit vectors (body frame) at a site on the reference sphere. Polar fallback
 * (SCIENTIFIC_REFERENCE.md: "stable fallback tied to the body-fixed X axis"): where north is
 * undefined, use its limit along the prime meridian — +X at the south pole, −X at the north pole.
 */
export function enuBasis(latDeg: number, lonDeg: number): EnuBasis {
  const la = latDeg * DEG;
  const lo = lonDeg * DEG;
  const up: Vec3 = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  let east = cross([0, 0, 1], up);
  // Limit along lon 0 is east = +Y at both poles (north = +X south, −X north).
  if (Math.hypot(...east) < 1e-9) east = [0, 1, 0];
  east = unit(east);
  return { east, north: cross(up, east), up };
}

/**
 * Local azimuth/elevation of a body-frame direction at a site (planetocentric lat, east lon).
 * ENU on the sphere (polar fallback: see enuBasis). Azimuth of a zenith/nadir direction is 0.
 */
export function localAzEl(dir: Vec3, latDeg: number, lonDeg: number): AzEl {
  const { east, north, up } = enuBasis(latDeg, lonDeg);
  const d = unit(dir);
  const e = dot(d, east);
  const n = dot(d, north);
  const u = dot(d, up);
  const h = Math.hypot(e, n);
  return { azimuthDeg: h < 1e-12 ? 0 : wrap360(Math.atan2(e, n) / DEG), elevationDeg: Math.atan2(u, h) / DEG };
}

/** Unit ENU vector [east, north, up] of an azimuth/elevation (inverse of the angles above). */
export function azElToEnu({ azimuthDeg, elevationDeg }: AzEl): Vec3 {
  const a = azimuthDeg * DEG;
  const e = elevationDeg * DEG;
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
}

/**
 * Earth body-fixed → local ENU [east, north, up] at the site, row-major 3×3 (texture orientation
 * of the Earth seen from the ground, visualization only).
 */
export function earthToEnu(sky: MoonSky, latDeg: number, lonDeg: number): number[] {
  const { east, north, up } = enuBasis(latDeg, lonDeg);
  const rows = [east, north, up];
  const m = sky.earthToBody;
  const out: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push(rows[r][0] * m[c] + rows[r][1] * m[3 + c] + rows[r][2] * m[6 + c]);
  return out;
}
