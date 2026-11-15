// Mirrors packages/contracts/schemas/trajectory-simulate-{request,response}.schema.json (source of truth).

export interface TrajectoryRequest {
  site: { latitude_deg: number; longitude_deg: number; altitude_km?: number };
  /** departure from the 200 km Earth parking orbit, UTC ISO 8601 with Z */
  departure_utc: string;
  /** target transfer duration (the tool searches ± 2 days around it) */
  transfer_days?: number;
}

export interface TrajectorySegment {
  phase: "transfer" | "descent";
  utc: string[];
  /** geocentric ECLIPJ2000, metres (same frame as /celestial/*) */
  positions_m: [number, number, number][];
  altitude_above_site_km: number[];
  speed_relative_to_moon_m_s: number[];
}

export interface TrajectoryResponse {
  schema_version: string;
  status: "computed" | "no_solution" | "not_ready";
  synthetic: false;
  message: string;
  request: TrajectoryRequest;
  frame: { name: string; description: string } | null;
  model: Record<string, string> | null;
  segments: TrajectorySegment[];
  /** the vecteur-traj tool's own summaries, passed through (French keys) */
  transfer: Record<string, unknown> | null;
  descent: Record<string, unknown> | null;
  assumptions: string[];
  warnings: string[];
}
