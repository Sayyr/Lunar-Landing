// Sun / Earth directions as seen from the Moon.
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
