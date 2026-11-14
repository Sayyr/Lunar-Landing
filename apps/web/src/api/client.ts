import type {
  ErrorResponse,
  HealthResponse,
  PresetSite,
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
  const json = text ? JSON.parse(text) : null;
  if (!resp.ok) throw new ApiError(resp.status, json?.error ? (json as ErrorResponse) : null);
  return json as T;
}

export const api = {
  health: () => request<HealthResponse>("/v1/health"),
  sites: () => request<{ sites: PresetSite[] }>("/v1/sites").then((r) => r.sites),
  evaluate: (req: ScenarioRequest) =>
    request<ScenarioResponse>("/v1/scenarios/evaluate", { method: "POST", body: JSON.stringify(req) }),
  /** SYNTHETIC demo data only — never for analysis. */
  evaluateSynthetic: (req: ScenarioRequest) =>
    request<ScenarioResponse>("/v1/demo/synthetic/evaluate", { method: "POST", body: JSON.stringify(req) }),
  /** Server-side slope check of a circular zone on the full-resolution DEM (science service). */
  slopeCheck: (req: SlopeCheckRequest) =>
    request<SlopeCheckResponse>("/v1/terrain/slope/check", { method: "POST", body: JSON.stringify(req) }),
};
