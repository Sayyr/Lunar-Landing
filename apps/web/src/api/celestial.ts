import { mockCelestialState, mockMoonTrack, mockSunTrack } from "../mock/celestialMock";
import type { CelestialStateResponse } from "./celestialTypes";

// Single integration point for the Sun/Earth/Moon state.
// TODO(backend): replace with `request<CelestialStateResponse>(`/celestial/state?utc=${...}`)` once
// services/science + services/api expose it. The mock is synchronous; keep the async signature so
// callers do not change when the real endpoint lands.
export async function getCelestialState(date: Date): Promise<CelestialStateResponse> {
  return mockCelestialState(date);
}

// shortcut: the orbit traces are synchronous and not in the draft contract; when the backend lands,
// add them to the response (or an async call) and fetch them in CelestialDashboard, not the scene.

/** Earth→Moon positions (metres, ecliptic of date) for an orbit trace. Mock for now. */
export function getMoonTrack(center: Date, halfSpanDays = 13.7, stepHours = 3): [number, number, number][] {
  return mockMoonTrack(center, halfSpanDays, stepHours);
}

/** Earth→Sun positions (metres) over a year, for drawing Earth's orbit. Mock for now. */
export function getSunTrack(center: Date): [number, number, number][] {
  return mockSunTrack(center);
}
