import { describe, expect, it } from "vitest";

import type { ScenarioRequest } from "../api/types";
import { buildRadioRequest, DEFAULT_RADIO_SETTINGS, formatDuration, formatPercent, STATION_PRESETS } from "./radio";

const scenario: ScenarioRequest = {
  site: { latitude_deg: -89.5, longitude_deg: 0, observer_height_m: 2 },
  start_utc: "2026-11-15T00:00:00Z",
  duration_hours: 72,
  step_minutes: 10,
  terrain_mode: "ideal",
};

describe("buildRadioRequest", () => {
  it("reuses the scenario site and time grid and drops terrain_mode", () => {
    const r = buildRadioRequest(scenario, DEFAULT_RADIO_SETTINGS);
    expect(r.site).toEqual(scenario.site);
    expect(r.start_utc).toBe(scenario.start_utc);
    expect(r.duration_hours).toBe(72);
    expect(r.step_minutes).toBe(10);
    expect("terrain_mode" in r).toBe(false);
    // exactly the keys of radio-link-request.schema.json (additionalProperties: false)
    expect(Object.keys(r).sort()).toEqual(
      ["duration_hours", "link", "min_earth_elevation_deg", "site", "start_utc", "stations", "step_minutes"].sort(),
    );
  });

  it("applies the common mask to every selected station", () => {
    const r = buildRadioRequest(scenario, { ...DEFAULT_RADIO_SETTINGS, stationMaskDeg: 6, stations: [2, 0] });
    expect(r.stations.map((s) => s.name)).toEqual([STATION_PRESETS[2].name, STATION_PRESETS[0].name]);
    expect(r.stations.every((s) => s.min_elevation_deg === 6)).toBe(true);
  });

  it("ignores unknown and duplicate station indices (names must be unique)", () => {
    const r = buildRadioRequest(scenario, { ...DEFAULT_RADIO_SETTINGS, stations: [1, 1, 7, -1] });
    expect(r.stations).toHaveLength(1);
  });

  it("station presets satisfy the request schema ranges", () => {
    for (const s of STATION_PRESETS) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.name.length).toBeLessThanOrEqual(64);
      expect(Math.abs(s.latitude_deg)).toBeLessThanOrEqual(90);
      expect(s.longitude_deg).toBeGreaterThanOrEqual(-180);
      expect(s.longitude_deg).toBeLessThan(180);
    }
    expect(new Set(STATION_PRESETS.map((s) => s.name)).size).toBe(STATION_PRESETS.length);
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatDuration(0.75)).toBe("45 min");
    expect(formatDuration(12)).toBe("12.0 h");
    expect(formatDuration(76.5)).toBe("3 d 4.5 h");
    expect(formatDuration(NaN)).toBe("—");
  });
  it("formats fractions, null for a single-sample grid", () => {
    expect(formatPercent(0.4907)).toBe("49.1 %");
    expect(formatPercent(null)).toBe("—");
  });
});
