// MOCK EPHEMERIS: front-end stand-in until the science service exposes Sun/Earth/Moon state.
//
// This is NOT the authoritative geometry (that will be SPICE in services/science). It runs the
// published *low-precision* formulae so the dashboard shows positions that are plausible for the
// selected date, not random numbers. Everything it produces is labelled `synthetic` in the UI.
//
// Sources (formula coefficients copied from):
//   - Moon: Astronomical Almanac, "Low-precision formulae for geocentric coordinates of the Moon"
//     (section D). Nominal accuracy stated by the source, 1900-2100: λ 0.3°, β 0.2°, parallax 0.003°.
//   - Sun: Astronomical Almanac, "Low precision formulas for the Sun" (section C).
//     Nominal accuracy stated by the source, 1950-2050: 0.01° in λ.
//   - GMST: IAU 1982 expression (Meeus, Astronomical Algorithms, eq. 12.4).
//   - Mean obliquity: Astronomical Almanac low-precision expression ε = 23.439° − 0.0000004°·n.
// These accuracy figures are the sources' claims; this repo only spot-checks them (see test file).
//
// Frame: geocentric ecliptic and mean equinox OF DATE (not J2000, not a SPICE frame).
// Units: radians and kilometres internally; the provider converts to degrees / metres at the
// mock-API boundary (CLAUDE.md convention).

import { AU_M, DEG } from "../lib/constants";

export { DEG };
export const AU_KM = AU_M / 1000;
export const EARTH_EQ_RADIUS_KM = 6378.14; // value the AA formula uses to turn parallax into distance

/** TT − UTC = (TAI − UTC) + 32.184 s. TAI − UTC = 37 s since 2017-01-01 (no later leap second assumed). */
export const TT_MINUS_UTC_S = 37 + 32.184;

export type Vec3 = [number, number, number];

const J2000_JD = 2451545.0;

export function julianDateUtc(date: Date): number {
  return date.getTime() / 86_400_000 + 2440587.5;
}

export function julianDateTt(date: Date): number {
  return julianDateUtc(date) + TT_MINUS_UTC_S / 86_400;
}

export function normDeg(x: number): number {
  return ((x % 360) + 360) % 360;
}

const sinD = (x: number) => Math.sin(x * DEG);
const cosD = (x: number) => Math.cos(x * DEG);

export interface EclipticPosition {
  /** ecliptic longitude, radians in [0, 2π) */
  lon: number;
  /** ecliptic latitude, radians */
  lat: number;
  /** distance, km */
  distKm: number;
}

/** Geocentric Moon, ecliptic & mean equinox of date. `jdTt` is a TT Julian date. */
export function moonGeocentric(jdTt: number): EclipticPosition {
  const T = (jdTt - J2000_JD) / 36525;
  const lonDeg =
    218.32 +
    481267.881 * T +
    6.29 * sinD(135.0 + 477198.87 * T) -
    1.27 * sinD(259.3 - 413335.36 * T) +
    0.66 * sinD(235.7 + 890534.22 * T) +
    0.21 * sinD(269.9 + 954397.74 * T) -
    0.19 * sinD(357.5 + 35999.05 * T) -
    0.11 * sinD(186.5 + 966404.03 * T);
  const latDeg =
    5.13 * sinD(93.3 + 483202.02 * T) +
    0.28 * sinD(228.2 + 960400.89 * T) -
    0.28 * sinD(318.3 + 6003.15 * T) -
    0.17 * sinD(217.6 - 407332.21 * T);
  const parallaxDeg =
    0.9508 +
    0.0518 * cosD(135.0 + 477198.87 * T) +
    0.0095 * cosD(259.3 - 413335.36 * T) +
    0.0078 * cosD(235.7 + 890534.22 * T) +
    0.0028 * cosD(269.9 + 954397.74 * T);
  return {
    lon: normDeg(lonDeg) * DEG,
    lat: latDeg * DEG,
    distKm: EARTH_EQ_RADIUS_KM / Math.sin(parallaxDeg * DEG),
  };
}

/** Geocentric Sun (apparent longitude, β = 0 by construction), ecliptic & mean equinox of date. */
export function sunGeocentric(jdTt: number): EclipticPosition {
  const n = jdTt - J2000_JD;
  const L = 280.46 + 0.9856474 * n;
  const g = 357.528 + 0.9856003 * n;
  const lonDeg = L + 1.915 * sinD(g) + 0.02 * sinD(2 * g);
  const rAu = 1.00014 - 0.01671 * cosD(g) - 0.00014 * cosD(2 * g);
  return { lon: normDeg(lonDeg) * DEG, lat: 0, distKm: rAu * AU_KM };
}

/** Mean obliquity of the ecliptic, radians. */
export function meanObliquity(jdTt: number): number {
  return (23.439 - 0.0000004 * (jdTt - J2000_JD)) * DEG;
}

/** Greenwich mean sidereal time, radians in [0, 2π). UT1 ≈ UTC (|UT1−UTC| < 0.9 s ⇒ < 0.004°). */
export function gmst(jdUt: number): number {
  const d = jdUt - J2000_JD;
  const T = d / 36525;
  const deg = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - (T * T * T) / 38_710_000;
  return normDeg(deg) * DEG;
}

export function eclipticToCartesian(p: EclipticPosition): Vec3 {
  const c = Math.cos(p.lat);
  return [p.distKm * c * Math.cos(p.lon), p.distKm * c * Math.sin(p.lon), p.distKm * Math.sin(p.lat)];
}

export function cartesianToEcliptic(v: Vec3): EclipticPosition {
  const r = Math.hypot(v[0], v[1], v[2]);
  if (r === 0) throw new Error("zero vector has no direction");
  const lon = Math.atan2(v[1], v[0]);
  return { lon: lon < 0 ? lon + 2 * Math.PI : lon, lat: Math.asin(v[2] / r), distKm: r };
}

/** Ecliptic (of date) → equatorial (of date) right ascension / declination, radians. */
export function eclipticToEquatorial(p: EclipticPosition, eps: number): { ra: number; dec: number } {
  const [x, y, z] = eclipticToCartesian({ ...p, distKm: 1 });
  const ye = y * Math.cos(eps) - z * Math.sin(eps);
  const ze = y * Math.sin(eps) + z * Math.cos(eps);
  const ra = Math.atan2(ye, x);
  return { ra: ra < 0 ? ra + 2 * Math.PI : ra, dec: Math.asin(Math.max(-1, Math.min(1, ze))) };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function angleBetween(a: Vec3, b: Vec3): number {
  // atan2 form stays accurate for very small and near-180° angles.
  const cross: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return Math.atan2(Math.hypot(...cross), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
}

/** Row-major 3×3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/**
 * Earth body-fixed (Greenwich meridian = +X, north pole = +Z) → ecliptic of date.
 * Model: rotation by GMST about the pole, then equator → ecliptic by mean obliquity.
 * Ignores precession-nutation offsets beyond "of date", polar motion and UT1−UTC: fine for
 * orienting a texture, not for geodesy.
 */
export function earthFixedToEcliptic(jdUt: number, jdTt: number): Mat3 {
  const g = gmst(jdUt);
  const e = meanObliquity(jdTt);
  const cg = Math.cos(g), sg = Math.sin(g), ce = Math.cos(e), se = Math.sin(e);
  // Rz(g): body → equatorial;  then [1 0 0; 0 ce se; 0 −se ce]: equatorial → ecliptic.
  return [cg, -sg, 0, ce * sg, ce * cg, se, -se * sg, -se * cg, ce];
}
