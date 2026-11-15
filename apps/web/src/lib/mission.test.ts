import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Correction, MissionRequest, MissionResponse } from "../api/missionTypes";
import type { ScenarioRequest } from "../api/types";
import { applyCorrection, bestIndex, buildMissionRequest, comparisonRows, EXAMPLE_CONSTRAINTS, EXAMPLE_POWER, hoursBetween, toFormUtc, workedEnergyStep } from "./mission";
import { DEFAULT_RADIO_SETTINGS } from "./radio";

const scenario: ScenarioRequest = {
  site: { latitude_deg: -89.5, longitude_deg: 0, observer_height_m: 2 },
  start_utc: "2026-11-15T00:00:00Z",
  duration_hours: 72,
  step_minutes: 10,
  terrain_mode: "dem",
};
// Read at test time (not imported): the web Docker build copies only apps/web, and `tsc -b` type-checks tests too.
const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../packages/contracts/fixtures/${name}`, import.meta.url)), "utf8"));
const req = fixture("mission-simulate-request.valid.json") as MissionRequest;
const synthetic = fixture("mission-simulate-response.synthetic.json");
const corr = (c: Partial<Correction>): Correction => ({
  kind: "abort",
  feasible: true,
  summary: "",
  landing_utc: null,
  surface_hours: null,
  battery_capacity_wh: null,
  panel_area_m2: null,
  site: null,
  max_slope_deg: null,
  verdict: null,
  ...c,
});

describe("buildMissionRequest", () => {
  it("maps the scenario grid to the planned landing and the stay", () => {
    const r = buildMissionRequest(scenario, { power: EXAMPLE_POWER, constraints: EXAMPLE_CONSTRAINTS, radio: null, preLandingLoadW: null, endPolicy: "fixed_end" }, 12);
    expect(r.landing_utc).toBe(scenario.start_utc);
    expect(r.surface_hours).toBe(72);
    expect(r.terrain_mode).toBe("dem");
    expect(r.delay).toEqual({ landing_delay_hours: 12, end_policy: "fixed_end", pre_landing_net_load_w: null });
    expect(r.radio).toBeNull();
  });

  it("leaves energy out when power is off, and drops the battery reserve with it", () => {
    const r = buildMissionRequest(scenario, { power: null, constraints: EXAMPLE_CONSTRAINTS, radio: null, preLandingLoadW: 80, endPolicy: "fixed_duration" });
    expect(r.power).toBeNull();
    expect(r.constraints.min_battery_soc).toBeNull();
    expect(r.constraints.max_slope_deg).toBe(EXAMPLE_CONSTRAINTS.max_slope_deg);
    expect(applyCorrection(r, corr({ kind: "resize_battery", battery_capacity_wh: 9000 }))).toBeNull();
  });

  it("adds the radio link with the selected stations", () => {
    const r = buildMissionRequest(scenario, { power: EXAMPLE_POWER, constraints: EXAMPLE_CONSTRAINTS, radio: DEFAULT_RADIO_SETTINGS, preLandingLoadW: 50, endPolicy: "fixed_duration" });
    expect(r.radio?.stations).toHaveLength(3);
    expect(Object.keys(r.radio!)).toEqual(["min_earth_elevation_deg", "link", "stations"]); // no site/time fields
  });
});

describe("applyCorrection", () => {
  it("turns a new landing time into a longer delay from the planned landing", () => {
    const r = applyCorrection(req, corr({ kind: "retime_landing", landing_utc: "2026-11-16T06:00:00.000Z" }))!;
    expect(r.landing_utc).toBe(req.landing_utc);
    expect(r.delay!.landing_delay_hours).toBe(30);
    expect(hoursBetween("2026-11-15T00:00:00Z", "2026-11-15T12:30:00Z")).toBe(12.5);
  });

  it("moves the planned date (no delay) for change_date", () => {
    const r = applyCorrection({ ...req, delay: { landing_delay_hours: 30, end_policy: "fixed_end", pre_landing_net_load_w: 80 } }, corr({ kind: "change_date", landing_utc: "2026-11-13T06:00:00.000Z" }))!;
    expect(r.landing_utc).toBe("2026-11-13T06:00:00.000Z");
    expect(r.delay).toEqual({ landing_delay_hours: 0, end_policy: "fixed_duration", pre_landing_net_load_w: 80 });
    expect(toFormUtc("2026-11-13T06:00:00.000Z")).toBe("2026-11-13T06:00:00Z");
  });

  it("moves the site and relaxes the slope limit", () => {
    const m = applyCorrection(req, corr({ kind: "move_site", site: { latitude_deg: -89.45, longitude_deg: 12.5 } }))!;
    expect(m.site).toEqual({ ...req.site, latitude_deg: -89.45, longitude_deg: 12.5 });
    expect(applyCorrection(req, corr({ kind: "relax_slope", max_slope_deg: 12.3 }))!.constraints.max_slope_deg).toBe(12.3);
    expect(applyCorrection(req, corr({ kind: "move_site" }))).toBeNull();
    const both = applyCorrection(req, corr({ kind: "move_site", site: { latitude_deg: -89.5, longitude_deg: 1 }, landing_utc: "2026-11-16T00:00:00.000Z" }))!;
    expect(both.landing_utc).toBe("2026-11-16T00:00:00.000Z");
    expect(both.delay!.landing_delay_hours).toBe(0);
  });

  it("applies stay, battery and array changes and refuses abort", () => {
    expect(applyCorrection(req, corr({ kind: "abort" }))).toBeNull();
    const s = applyCorrection({ ...req, delay: { landing_delay_hours: 5, end_policy: "fixed_end", pre_landing_net_load_w: null } }, corr({ kind: "shorten_stay", surface_hours: 20 }))!;
    expect(s.surface_hours).toBe(20);
    expect(s.delay).toEqual({ landing_delay_hours: 5, end_policy: "fixed_duration", pre_landing_net_load_w: null });
    expect(applyCorrection(req, corr({ kind: "resize_battery", battery_capacity_wh: 9000 }))!.power!.battery_capacity_wh).toBe(9000);
    expect(applyCorrection(req, corr({ kind: "resize_panels", panel_area_m2: 4.5 }))!.power!.panel_area_m2).toBe(4.5);
    expect(applyCorrection(req, corr({ kind: "resize_panels" }))).toBeNull(); // no value
  });
});

describe("comparison", () => {
  it("builds rows from the contract fixture", () => {
    const r = synthetic as unknown as MissionResponse;
    const rows = comparisonRows([r, r]);
    expect(rows[0]).toMatchObject({ label: "Verdict", values: [r.verdict, r.verdict] });
    expect(rows.find((x) => x.label === "Surface stay (h)")!.values).toEqual([72, 72]);
  });

  it("picks the best value and reports ties as none", () => {
    expect(bestIndex({ label: "", values: [3, 5, 4], better: "higher" })).toBe(1);
    expect(bestIndex({ label: "", values: [3, 5, 4], better: "lower" })).toBe(0);
    expect(bestIndex({ label: "", values: [5, 5], better: "higher" })).toBe(-1);
    expect(bestIndex({ label: "", values: [null, 2], better: "higher" })).toBe(1);
    expect(bestIndex({ label: "", values: [1, 2], better: null })).toBe(-1);
  });
});

describe("workedEnergyStep", () => {
  it("re-does an unclamped step of the synthetic fixture and matches the service", () => {
    const s = workedEnergyStep(synthetic as MissionResponse)!;
    // fixture: 12:00 -> 18:00 on 16 Nov, Sun down, battery full -> 3000 - 150 W x 6 h / 0.95
    expect(s.from).toBe("2026-11-16T12:00:00.000Z");
    expect(s.genW).toBe(0);
    expect(s.nextWh).toBeCloseTo(3000 - (150 * 6) / 0.95, 9);
    expect(s.nextWh).toBeCloseTo(s.returnedWh, 6);
  });
  it("returns null when energy is not modelled", () => {
    expect(workedEnergyStep({ ...(synthetic as MissionResponse), request: { ...req, power: null } })).toBeNull();
  });
});
