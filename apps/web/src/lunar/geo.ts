// Lunar coordinate conversions and formatting (ported from apps/moon-explorer/js/geo.js).
// Pure module (no three.js, no DOM).
//
// Conventions:
//  - planetocentric latitude, degrees, [-90, 90];
//  - east-positive longitude normalised to [-180, 180);
//  - reference radius R = 1737.4 km (IAU/LOLA sphere used by the NASA SVS CGI Moon Kit).
//  - scene axes (three.js, Y-up): lon 0° on +X, lon +90° E on −Z, north pole on +Y.
//    The same convention is used by lib/sceneFrame.ts for the Sun–Earth–Moon dashboard.

import { DEG, MOON_RADIUS_KM } from "../lib/constants";

export { MOON_RADIUS_KM };

export interface LatLon {
  lat: number;
  lon: number;
}

/** Wraps a longitude (degrees) into [-180, 180). */
export function normalizeLon(lon: number): number {
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  return l === 180 ? -180 : l;
}

/**
 * three.js SphereGeometry UV → lat/lon: lon = u·360 − 180, lat = v·180 − 90.
 * Valid because the textures are equirectangular with lon −180° at the left edge.
 */
export function uvToLatLon(u: number, v: number): LatLon {
  return { lat: v * 180 - 90, lon: normalizeLon(u * 360 - 180) };
}

/**
 * Scene point → SphereGeometry UV. three.js builds the sphere with
 * x = −cos(φ)·sin(θ), y = cos(θ), z = sin(φ)·sin(θ), φ = u·2π, θ = (1 − v)·π; this inverts it.
 * The point's radius is ignored. At the poles atan2(0, −0) = π gives a deterministic lon 0°.
 */
export function pointToUv(x: number, y: number, z: number): { u: number; v: number } {
  const r = Math.hypot(x, y, z);
  if (r === 0) throw new Error("zero vector has no direction");
  const theta = Math.acos(Math.max(-1, Math.min(1, y / r)));
  let phi = Math.atan2(z, -x); // (−π, π]
  if (phi < 0) phi += 2 * Math.PI;
  return { u: phi / (2 * Math.PI), v: 1 - theta / Math.PI };
}

/** lat/lon (degrees) → unit vector in scene axes (inverse of pointToUv). */
export function latLonToUnit(lat: number, lon: number): { x: number; y: number; z: number } {
  const phi = (lon + 180) * DEG; // φ = u·2π with u = (lon + 180)/360
  const theta = (90 - lat) * DEG;
  return {
    x: -Math.cos(phi) * Math.sin(theta),
    y: Math.cos(theta),
    z: Math.sin(phi) * Math.sin(theta),
  };
}

/** Great-circle (haversine) distance in km on a sphere of radius R. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number, R = MOON_RADIUS_KM): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Rounds a longitude already in [-180, 180): 179.99996 must not become 180. Only the upper end can
 * overflow; re-wrapping with normalizeLon would add float noise (−12.3457 → −12.345699999999965).
 */
export function roundLon(lon: number, digits: number): number {
  const r = +lon.toFixed(digits);
  return r >= 180 ? r - 360 : r;
}

/** "12.345° N" / "45.678° W". */
export function formatLat(lat: number, digits = 3): string {
  return `${Math.abs(lat).toFixed(digits)}° ${lat >= 0 ? "N" : "S"}`;
}

/** Longitude is undefined at the poles: shown as "— (pole)" within 1e-4° of ±90°. */
export function formatLon(lon: number, lat = 0, digits = 3): string {
  if (Math.abs(lat) > 89.9999) return "— (pole)";
  const l = normalizeLon(lon);
  return `${Math.abs(l).toFixed(digits)}° ${l >= 0 ? "E" : "W"}`;
}

export function formatAltM(altM: number | null | undefined): string {
  if (altM == null || !Number.isFinite(altM)) return "—";
  return `${Math.round(altM).toLocaleString("en-US")} m`;
}
