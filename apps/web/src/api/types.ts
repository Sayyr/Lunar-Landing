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

// packages/contracts/schemas/slope-check-{request,response}.schema.json

export interface SlopeCheckRequest {
  zone: { center_latitude_deg: number; center_longitude_deg: number; radius_m: number };
  max_slope_deg: number;
  /** default 1.0 (applied by the science service) */
  required_fraction?: number;
  /** default 0.0 (applied by the science service) */
  max_nodata_fraction?: number;
}

export interface SlopeCheckResponse {
  status: "computed" | "out_of_coverage" | "dem_unavailable";
  verdict: "pass" | "fail" | "insufficient_data" | "not_evaluated";
  request: Required<SlopeCheckRequest>;
  stats: {
    pixel_count: number;
    nodata_count: number;
    fraction_ok: number;
    slope_max_deg: number | null;
    slope_mean_deg: number | null;
    slope_p95_deg: number | null;
    worst_pixel?: { latitude_deg: number; longitude_deg: number; slope_deg: number } | null;
  } | null;
  model: { method: string; baseline_m: number | null; body_fixed_frame: string | null; projection: string | null };
  data_provenance: { dem_product: string; dem_sha256?: string | null; [k: string]: unknown };
  assumptions: string[];
  warnings: string[];
}
