// Mission form state → MissionRequest, corrections → modified request, and comparison rows.
// No physics here: the science service simulates; this file only does bookkeeping.
import type { Correction, MissionConstraints, MissionRequest, MissionResponse, PowerParams } from "../api/missionTypes";
import type { ScenarioRequest } from "../api/types";
import { buildRadioRequest, type RadioSettings } from "./radio";

/**
 * ILLUSTRATIVE starting values so the form is not empty. They describe no real lander: replace them
 * with the figures of the vehicle under study.
 */
export const EXAMPLE_POWER: PowerParams = {
  panel_area_m2: 3,
  panel_efficiency: 0.28,
  panel_pointing: "vertical",
  load_w: 200,
  battery_capacity_wh: 6000,
  battery_initial_soc: 0.95,
  charge_efficiency: 0.95,
  discharge_efficiency: 0.95,
};

export const EXAMPLE_CONSTRAINTS: MissionConstraints = {
  min_battery_soc: 0.2,
  max_earth_outage_hours: 48,
  min_contact_hours: null,
  min_data_volume_mbit: null,
  max_slope_deg: 10,
  min_slope_ok_fraction: 0.95,
};

export interface MissionSettings {
  /** null = energy not modelled (optional, lowest priority) */
  power: PowerParams | null;
  constraints: MissionConstraints;
  /** null = no radio: contact = geometric Earth visibility */
  radio: RadioSettings | null;
  /** battery draw while waiting before landing, W; null = not modelled */
  preLandingLoadW: number | null;
  endPolicy: "fixed_duration" | "fixed_end";
}

/** The scenario's site/time grid becomes the planned landing and the surface stay. */
export function buildMissionRequest(scenario: ScenarioRequest, s: MissionSettings, delayHours = 0): MissionRequest {
  const radio = s.radio ? buildRadioRequest(scenario, s.radio) : null;
  return {
    site: scenario.site,
    landing_utc: scenario.start_utc,
    surface_hours: scenario.duration_hours,
    step_minutes: scenario.step_minutes,
    terrain_mode: scenario.terrain_mode,
    delay: { landing_delay_hours: delayHours, end_policy: s.endPolicy, pre_landing_net_load_w: s.preLandingLoadW },
    power: s.power,
    radio: radio && { min_earth_elevation_deg: radio.min_earth_elevation_deg, link: radio.link, stations: radio.stations },
    // Without a power model the battery reserve cannot be evaluated: do not send it.
    constraints: s.power ? s.constraints : { ...s.constraints, min_battery_soc: null },
  };
}

/** The correction's landing time as the new planned landing (no delay), when it carries one. */
function withDate(req: MissionRequest, c: Correction): MissionRequest {
  if (!c.landing_utc) return req;
  const delay = req.delay ?? { landing_delay_hours: 0, end_policy: "fixed_duration" as const, pre_landing_net_load_w: null };
  return { ...req, landing_utc: c.landing_utc, delay: { ...delay, landing_delay_hours: 0, end_policy: "fixed_duration" } };
}

/** "2026-11-15T06:00:00.000Z" → "2026-11-15T06:00:00Z" (the form's planned-landing format). */
export const toFormUtc = (iso: string) => `${iso.slice(0, 19)}Z`;

/** Hours between two UTC ISO strings (b − a). */
export const hoursBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3_600_000;

/**
 * The request a correction stands for. retime_landing keeps the planned landing and expresses the new
 * landing as a longer delay; shorten_stay fixes the stay length explicitly. abort has no request.
 */
export function applyCorrection(req: MissionRequest, c: Correction): MissionRequest | null {
  const delay = req.delay ?? { landing_delay_hours: 0, end_policy: "fixed_duration" as const, pre_landing_net_load_w: null };
  switch (c.kind) {
    case "abort":
      return null;
    case "retime_landing":
      if (!c.landing_utc) return null;
      return { ...req, delay: { ...delay, landing_delay_hours: Math.max(0, hoursBetween(req.landing_utc, c.landing_utc)) } };
    case "change_date":
      if (!c.landing_utc) return null;
      return { ...req, landing_utc: c.landing_utc, delay: { ...delay, landing_delay_hours: 0, end_policy: "fixed_duration" } };
    // Site / slope fixes may come with a date (the nearest one passing there): applied as the new plan.
    case "move_site":
      if (!c.site) return null;
      return withDate({ ...req, site: { ...req.site, latitude_deg: c.site.latitude_deg, longitude_deg: c.site.longitude_deg } }, c);
    case "relax_slope":
      if (c.max_slope_deg == null) return null;
      return withDate({ ...req, constraints: { ...req.constraints, max_slope_deg: c.max_slope_deg } }, c);
    case "shorten_stay":
      if (c.surface_hours == null) return null;
      return { ...req, surface_hours: c.surface_hours, delay: { ...delay, end_policy: "fixed_duration" } };
    case "resize_battery":
      if (c.battery_capacity_wh == null || !req.power) return null;
      return { ...req, power: { ...req.power, battery_capacity_wh: c.battery_capacity_wh } };
    case "resize_panels":
      if (c.panel_area_m2 == null || !req.power) return null;
      return { ...req, power: { ...req.power, panel_area_m2: c.panel_area_m2 } };
  }
}

export interface ComparisonRow {
  label: string;
  values: (string | number | null)[];
  /** "higher" / "lower" is better, or null for neutral rows */
  better: "higher" | "lower" | null;
}

const num = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : v);

/** Side-by-side rows for saved mission results (same order as `results`). */
export function comparisonRows(results: MissionResponse[]): ComparisonRow[] {
  const inv = (r: MissionResponse) => r.inventory;
  const row = (label: string, pick: (r: MissionResponse) => string | number | null, better: ComparisonRow["better"] = null): ComparisonRow => ({
    label,
    values: results.map(pick),
    better,
  });
  return [
    row("Verdict", (r) => r.verdict),
    row("Landing (UTC)", (r) => r.pre_landing.landing_utc.slice(0, 16).replace("T", " ")),
    row("Delay (h)", (r) => r.pre_landing.landing_delay_hours, "lower"),
    row("Surface stay (h)", (r) => num(inv(r)?.surface_hours), "higher"),
    row("Sun (h)", (r) => num(inv(r)?.energy.sun_hours), "higher"),
    row("Longest night (h)", (r) => num(inv(r)?.energy.longest_sun_outage_hours), "lower"),
    row("Energy generated (kWh)", (r) => num(inv(r)?.energy.generated_wh != null ? inv(r)!.energy.generated_wh! / 1000 : null), "higher"),
    row("Load not supplied (Wh)", (r) => num(inv(r)?.energy.unserved_wh), "lower"),
    row("Min SoC (%)", (r) => num(inv(r)?.energy.min_soc != null ? inv(r)!.energy.min_soc! * 100 : null), "higher"),
    row("Battery needed (Wh)", (r) => num(inv(r)?.sizing?.required_battery_wh), "lower"),
    row("Array needed (m²)", (r) => num(inv(r)?.sizing?.required_panel_area_m2), "lower"),
    row("Contact (h)", (r) => num(inv(r)?.comms.link_hours ?? inv(r)?.comms.earth_visible_hours), "higher"),
    row("Longest contact gap (h)", (r) => num(inv(r)?.comms.longest_link_outage_hours ?? inv(r)?.comms.longest_earth_outage_hours), "lower"),
    row("Data volume (Mbit)", (r) => num(inv(r)?.comms.data_volume_mbit), "higher"),
    row("Disc ≤ max slope (%)", (r) => num(inv(r)?.slope?.fraction_ok != null ? inv(r)!.slope!.fraction_ok! * 100 : null), "higher"),
    row("Failed constraints", (r) => r.constraints.filter((c) => c.status === "fail").map((c) => c.id).join(", ") || "none"),
  ];
}

/** Index of the best numeric value in a row, or −1 (ties / no numbers / neutral row). */
export function bestIndex(row: ComparisonRow): number {
  if (!row.better) return -1;
  let best = -1;
  let tie = false;
  row.values.forEach((v, i) => {
    if (typeof v !== "number") return;
    const b = row.values[best];
    if (best < 0 || typeof b !== "number") return void (best = i);
    if (v === b) tie = true;
    else if (row.better === "higher" ? v > b : v < b) {
      best = i;
      tie = false;
    }
  });
  return tie ? -1 : best;
}
