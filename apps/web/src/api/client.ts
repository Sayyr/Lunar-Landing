import type { CelestialStateResponse, CelestialTracksResponse } from "./celestialTypes";
import type { MissionRequest, MissionResponse } from "./missionTypes";
import type {
  ErrorResponse,
  HealthResponse,
  PresetSite,
  RadioLinkRequest,
  RadioLinkResponse,
  ScenarioRequest,
  ScenarioResponse,
  SlopeCheckRequest,
  SlopeCheckResponse,
} from "./types";

// Relative base: Vite dev proxy (and nginx in Docker) forward /api/* to the Rust gateway.
const BASE = import.meta.env.VITE_API_BASE ?? "/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: ErrorResponse | null,
  ) {
    super(body?.error.message ?? `HTTP ${status}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    if (resp.ok) throw new Error(`invalid JSON in response to ${path}`);
  }
  if (!resp.ok) throw new ApiError(resp.status, Array.isArray(json?.error?.details) ? (json as ErrorResponse) : null);
  return json as T;
}

export const api = {
  health: (signal?: AbortSignal) => request<HealthResponse>("/v1/health", { signal }),
  sites: (signal?: AbortSignal) => request<{ sites: PresetSite[] }>("/v1/sites", { signal }).then((r) => r.sites),
  evaluate: (req: ScenarioRequest) =>
    request<ScenarioResponse>("/v1/scenarios/evaluate", { method: "POST", body: JSON.stringify(req) }),
  /** SYNTHETIC demo data only — never for analysis. */
  evaluateSynthetic: (req: ScenarioRequest) =>
    request<ScenarioResponse>("/v1/demo/synthetic/evaluate", { method: "POST", body: JSON.stringify(req) }),
  /** Server-side slope check of a circular zone on the full-resolution DEM (science service). */
  slopeCheck: (req: SlopeCheckRequest) =>
    request<SlopeCheckResponse>("/v1/terrain/slope/check", { method: "POST", body: JSON.stringify(req) }),
  /** Sun/Earth/Moon geometric state (SPICE) for the 3D views; 503 when ephemerides are unavailable. */
  celestialState: (utc: string) =>
    request<CelestialStateResponse>("/v1/celestial/state", { method: "POST", body: JSON.stringify({ utc }) }),
  /** Moon and Sun orbit traces (SPICE) around `utc`, for the 3D views; 503 when ephemerides are unavailable. */
  celestialTracks: (utc: string) =>
    request<CelestialTracksResponse>("/v1/celestial/tracks", { method: "POST", body: JSON.stringify({ utc }) }),
  /** Direct-to-Earth radio-link windows (engineering estimate, analytic ephemeris — not a link guarantee). */
  radioLink: (req: RadioLinkRequest) =>
    request<RadioLinkResponse>("/v1/scenarios/radio-link", { method: "POST", body: JSON.stringify(req) }),
  /** Surface-stay mission simulation: energy, comms, slope, constraints and corrections (engineering tier). */
  missionSimulate: (req: MissionRequest) =>
    request<MissionResponse>("/v1/scenarios/simulate", { method: "POST", body: JSON.stringify(req) }),
  /** The same on SYNTHETIC ephemerides — UI demo only, never for analysis. */
  missionSimulateSynthetic: (req: MissionRequest) =>
    request<MissionResponse>("/v1/demo/synthetic/simulate", { method: "POST", body: JSON.stringify(req) }),
};
