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
  /** Direct-to-Earth radio-link windows (engineering estimate, analytic ephemeris — not a link guarantee). */
  radioLink: (req: RadioLinkRequest) =>
    request<RadioLinkResponse>("/v1/scenarios/radio-link", { method: "POST", body: JSON.stringify(req) }),
};
