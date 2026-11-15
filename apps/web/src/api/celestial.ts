import { ApiError, api } from "./client";
import type { CelestialStateResponse, CelestialTracksResponse } from "./celestialTypes";

// Single integration point for the Sun/Earth/Moon data of every 3D view. Everything comes from the API:
// POST /api/v1/celestial/state and /celestial/tracks (science service, CSPICE + DE440, ECLIPJ2000).
// No ephemeris is computed in the browser: when the backend cannot answer (no kernels, service down,
// date outside the ephemeris) these reject with the reason, and the views say so.

/** After a failure, do not ask the backend again for this long (the views request on every tick). */
const RETRY_AFTER_MS = 15_000;
const CACHE_SIZE = 256;

let backendDownUntil = 0;
let lastFailure = "";
const states = new Map<number, CelestialStateResponse>();
const tracks = new Map<number, CelestialTracksResponse>();

function describe(e: unknown): string {
  if (e instanceof ApiError) return e.body ? e.body.error.message : `HTTP ${e.status}`;
  return `Backend not reachable (${e instanceof Error ? e.message : String(e)})`;
}

async function cached<T>(cache: Map<number, T>, date: Date, load: (utc: string) => Promise<T>): Promise<T> {
  const ms = date.getTime();
  if (Number.isNaN(ms)) throw new Error("invalid date");
  const hit = cache.get(ms);
  if (hit) return hit;
  if (Date.now() < backendDownUntil) throw new Error(lastFailure);
  try {
    const value = await load(date.toISOString());
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as number);
    cache.set(ms, value);
    return value;
  } catch (e) {
    lastFailure = describe(e);
    backendDownUntil = Date.now() + RETRY_AFTER_MS;
    throw new Error(lastFailure);
  }
}

/** Geometric Sun/Earth/Moon state at one instant. Rejects when the backend cannot provide it. */
export const getCelestialState = (date: Date) => cached(states, date, api.celestialState);

/** Moon (one sidereal month) and Sun (one year) orbit traces centred on `date`. Rejects like getCelestialState. */
export const getCelestialTracks = (date: Date) => cached(tracks, date, api.celestialTracks);

/** Test hook: forget cached responses and the back-off. */
export function resetCelestialClient(): void {
  states.clear();
  tracks.clear();
  backendDownUntil = 0;
  lastFailure = "";
}
