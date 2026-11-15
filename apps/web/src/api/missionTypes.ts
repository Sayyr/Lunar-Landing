// Mirrors packages/contracts/schemas/mission-simulate-{request,response}.schema.json (source of truth).
import type { GroundStation, LinkParams, Site, VisibilityWindow } from "./types";

export type PanelPointing = "sun_tracking" | "vertical" | "horizontal";
export type EndPolicy = "fixed_duration" | "fixed_end";

export interface PowerParams {
  panel_area_m2: number;
  panel_efficiency: number;
  panel_pointing: PanelPointing;
  load_w: number;
  battery_capacity_wh: number;
  battery_initial_soc: number;
  charge_efficiency: number;
  discharge_efficiency: number;
}

export interface MissionConstraints {
  min_battery_soc: number | null;
  max_earth_outage_hours: number | null;
  min_contact_hours: number | null;
  min_data_volume_mbit: number | null;
  max_slope_deg: number | null;
  min_slope_ok_fraction: number | null;
}

export interface MissionRequest {
  site: Site;
  /** PLANNED landing, before any delay */
  landing_utc: string;
  surface_hours: number;
  step_minutes: number;
  terrain_mode: "ideal" | "dem";
  delay?: { landing_delay_hours: number; end_policy: EndPolicy; pre_landing_net_load_w: number | null };
  /** optional (lowest priority): omitted / null = energy not modelled */
  power?: PowerParams | null;
  radio?: { min_earth_elevation_deg: number; link: LinkParams; stations: GroundStation[] } | null;
  constraints: MissionConstraints;
  search?: { max_extra_delay_hours?: number; step_hours?: number };
}

export type ConstraintId = "battery_reserve" | "earth_outage" | "contact_hours" | "data_volume" | "landing_slope" | "surface_time";

export interface ConstraintResult {
  id: ConstraintId;
  label: string;
  status: "pass" | "fail" | "not_evaluated";
  value: number | null;
  limit: number | null;
  first_violation_utc: string | null;
  note: string;
}

export type CorrectionKind = "abort" | "retime_landing" | "change_date" | "move_site" | "relax_slope" | "shorten_stay" | "resize_battery" | "resize_panels";

export interface Correction {
  kind: CorrectionKind;
  feasible: boolean;
  summary: string;
  landing_utc: string | null;
  surface_hours: number | null;
  battery_capacity_wh: number | null;
  panel_area_m2: number | null;
  /** move_site only */
  site: { latitude_deg: number; longitude_deg: number } | null;
  /** relax_slope only */
  max_slope_deg: number | null;
  verdict: Verdict | null;
}

export type Verdict = "go" | "no_go" | "incomplete";

export interface TimelineSample {
  utc: string;
  sun_visible: boolean;
  earth_visible: boolean;
  link_available: boolean | null;
  /** null when energy is not modelled */
  solar_w: number | null;
  battery_wh: number | null;
  soc: number | null;
}

export interface MissionInventory {
  landing_utc: string;
  end_utc: string;
  surface_hours: number;
  /** energy figures are null when energy is not modelled; Sun hours always come back */
  energy: {
    generated_wh: number | null;
    load_wh: number | null;
    unserved_wh: number | null;
    curtailed_wh: number | null;
    soc_at_landing: number | null;
    final_soc: number | null;
    min_soc: number | null;
    min_soc_utc: string | null;
    hours_below_reserve: number | null;
    sun_hours: number;
    longest_sun_outage_hours: number;
  };
  sizing: { reserve_soc: number; required_battery_wh: number | null; required_panel_area_m2: number | null } | null;
  comms: {
    contact_basis: "radio_link" | "geometric_earth_visibility";
    earth_visible_hours: number;
    longest_earth_outage_hours: number;
    link_hours: number | null;
    longest_link_outage_hours: number | null;
    data_volume_mbit: number | null;
  };
  slope: {
    status: string;
    verdict: string;
    radius_m: number;
    max_slope_deg: number;
    fraction_ok: number | null;
    slope_max_deg: number | null;
    slope_mean_deg: number | null;
  } | null;
}

export interface MissionResponse {
  schema_version: string;
  status: "computed" | "synthetic" | "not_ready";
  synthetic: boolean;
  message: string;
  request: MissionRequest;
  model: { ephemeris_provider: string; horizon_model: string; energy_model: string | null; radio_model: string | null; [k: string]: unknown };
  data_provenance: Record<string, unknown>[];
  assumptions: string[];
  warnings: string[];
  pre_landing: {
    planned_landing_utc: string;
    landing_utc: string;
    landing_delay_hours: number;
    end_policy: EndPolicy;
    net_load_w: number | null;
    energy_wh: number | null;
    soc_at_landing: number | null;
  };
  timeline: TimelineSample[];
  windows: { sun_visible: VisibilityWindow[]; earth_visible: VisibilityWindow[]; link_available: VisibilityWindow[] | null };
  inventory: MissionInventory | null;
  constraints: ConstraintResult[];
  verdict: Verdict;
  corrections: Correction[];
  /** only on no_go: the same mission re-simulated at nearby landing dates (no delay) */
  date_scan: DateScan | null;
}

export interface DateScan {
  step_hours: number;
  range_hours: number;
  /** constraints no date can change (the landing slope when it fails at this site) */
  ignored_constraints: string[];
  points: { landing_utc: string; offset_hours: number; verdict: Verdict; failed: string[] }[];
}
