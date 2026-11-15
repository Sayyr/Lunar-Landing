import { mockCelestialState, mockMoonTrack, mockSunTrack } from "../mock/celestialMock";
import { ApiError, api } from "./client";
import type { CelestialStateResponse } from "./celestialTypes";

// Single integration point for the Sun/Earth/Moon state used by every 3D view.
//
// Real data: POST /api/v1/celestial/state (science service, CSPICE + DE440, geometric positions in
// ECLIPJ2000). If that fails (no kernels on the server, services down, date outside the ephemeris)
// the browser's low-precision mock is used instead, and the response says so: `synthetic: true`,
// status "synthetic" and a first warning giving the reason. Callers must keep showing their
// SYNTHETIC label whenever `synthetic` is true.

/** After a failure, do not ask the backend again for this long (the views request on every tick). */
const RETRY_AFTER_MS = 15_000;
const CACHE_SIZE = 256;

let backendDownUntil = 0;
let lastFailure = "";
const cache = new Map<number, CelestialStateResponse>();

function describe(e: unknown): string {
  if (e instanceof ApiError) return e.body ? e.body.error.message : `HTTP ${e.status}`;
  return e instanceof Error ? e.message : String(e);
}

function fallback(date: Date): CelestialStateResponse {
  const mock = mockCelestialState(date);
  return {
    ...mock,
    warnings: [`Real ephemerides unavailable (${lastFailure || "backend not reachable"}): showing the browser's low-precision mock.`, ...mock.warnings],
  };
}

export async function getCelestialState(date: Date): Promise<CelestialStateResponse> {
  const ms = date.getTime();
  if (Number.isNaN(ms)) throw new Error("invalid date");
  const hit = cache.get(ms);
  if (hit) return hit;
  if (Date.now() < backendDownUntil) return fallback(date);
  try {
    const state = await api.celestialState(date.toISOString());
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as number);
    cache.set(ms, state);
    return state;
  } catch (e) {
    lastFailure = describe(e);
    backendDownUntil = Date.now() + RETRY_AFTER_MS;
    return fallback(date);
  }
}

/** Test hook: forget cached states and the back-off. */
export function resetCelestialClient(): void {
  cache.clear();
  backendDownUntil = 0;
  lastFailure = "";
}

// --- Orbit traces -------------------------------------------------------------------------------
// Decorative lines only, still computed in the browser from the low-precision formulae (the backend
// serves single instants). With a real (ECLIPJ2000) state they are rotated from the ecliptic of date
// to J2000 so the trace passes through the plotted body; they remain a low-precision illustration.

/** Mean sidereal month (days): the Moon returns to the same ecliptic longitude after this time. */
export const SIDEREAL_MONTH_DAYS = 27.321662;

type V3 = [number, number, number];

/**
 * Rotation of ecliptic-of-date coordinates to ECLIPJ2000, keeping only the general precession in
 * longitude (5028.796″ per Julian century, IAU 2006): λ_J2000 = λ_date − p·T. The motion of the
 * ecliptic plane itself (≈ 47″/century) is neglected, far below the accuracy of the traces.
 */
export function eclipticOfDateToJ2000(points: V3[], date: Date): V3[] {
  const centuries = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / (36525 * 86_400_000);
  const a = (-(5028.796195 / 3600) * centuries * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return points.map(([x, y, z]) => [c * x - s * y, s * x + c * y, z]);
}

/** Earth→Moon positions (metres) over one sidereal month by default. Low-precision trace. */
export function getMoonTrack(center: Date, j2000 = false, halfSpanDays = SIDEREAL_MONTH_DAYS / 2, stepHours = (SIDEREAL_MONTH_DAYS * 24) / 216): V3[] {
  const track = mockMoonTrack(center, halfSpanDays, stepHours);
  return j2000 ? eclipticOfDateToJ2000(track, center) : track;
}

/** Earth→Sun positions (metres) over a year, for drawing Earth's orbit. Low-precision trace. */
export function getSunTrack(center: Date, j2000 = false): V3[] {
  const track = mockSunTrack(center);
  return j2000 ? eclipticOfDateToJ2000(track, center) : track;
}
