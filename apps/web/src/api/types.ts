// Hand-written mirror of packages/contracts/schemas/*.json. Keep in sync with the schemas.

export type TerrainMode = "ideal" | "dem";

export interface Site {
  latitude_deg: number;
  longitude_deg: number;
  observer_height_m: number;
}

export interface ScenarioRequest {
  site: Site;
  start_utc: string;
  duration_hours: number;
  step_minutes: number;
  terrain_mode: TerrainMode;
}

export type ScenarioStatus = "computed" | "synthetic" | "not_ready";

export interface Direction {
  azimuth_deg: number;
  elevation_deg: number;
}

export interface Sample {
  utc: string;
  sun: Direction;
  earth: Direction;
}

export interface VisibilityWindow {
  start_utc: string;
  end_utc: string;
  clipped_start: boolean;
  clipped_end: boolean;
}

export interface Provenance {
  name: string;
  kind: "spice_kernel" | "dem" | "synthetic" | "other";
  source: string;
  version: string | null;
  license: string | null;
  notes: string;
}

export interface ScenarioResponse {
  schema_version: "0.1.0";
  status: ScenarioStatus;
  synthetic: boolean;
  message: string;
  request: ScenarioRequest;
  model: {
    ephemeris_provider: "spice" | "synthetic_fixture";
    horizon_model: "ideal_geometric" | "dem_terrain";
    body_fixed_frame: string | null;
    time_scale_note: string;
    kernel_set: string[];
  };
  data_provenance: Provenance[];
  assumptions: string[];
  warnings: string[];
  samples: Sample[];
  windows: { sun_visible: VisibilityWindow[]; earth_visible: VisibilityWindow[] };
}

export interface ErrorResponse {
  error: {
    code: "validation_error" | "not_found" | "science_unavailable" | "upstream_error" | "internal_error";
    message: string;
    details: { field: string; issue: string }[];
  };
}

export interface HealthResponse {
  service: "api" | "science";
  status: "ok" | "degraded";
  version: string;
  ephemeris?: { provider: string; ready: boolean; reason: string };
  upstream?: HealthResponse | null;
  upstream_error?: string | null;
}

export interface PresetSite {
  id: string;
  name: string;
  kind: "synthetic_test_point" | "published_candidate_region";
  latitude_deg: number;
  longitude_deg: number;
  source: string;
  notes: string;
}
