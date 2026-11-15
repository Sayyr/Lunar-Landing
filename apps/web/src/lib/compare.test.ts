import { describe, expect, it } from "vitest";

import type { ScenarioRequest, ScenarioResponse, VisibilityWindow } from "../api/types";
import { covered, intersect, longestGap, scenarioB, scenarioMetrics, toSpans, unite } from "./compare";

const h = (n: number) => n * 3.6e6;
const T0 = Date.parse("2026-11-15T00:00:00Z");
const at = (hours: number) => new Date(T0 + h(hours)).toISOString();
const win = (a: number, b: number, clippedStart = false, clippedEnd = false): VisibilityWindow => ({
  start_utc: at(a),
  end_utc: at(b),
  clipped_start: clippedStart,
  clipped_end: clippedEnd,
});

function response(hours: number, sun: VisibilityWindow[], earth: VisibilityWindow[]): ScenarioResponse {
  const samples = Array.from({ length: hours + 1 }, (_, i) => ({
    utc: at(i),
    sun: { azimuth_deg: 0, elevation_deg: 0 },
    earth: { azimuth_deg: 0, elevation_deg: 0 },
  }));
  return {
    schema_version: "0.1.0",
    status: "computed",
    synthetic: false,
    message: "",
    request: {} as ScenarioRequest,
    model: { ephemeris_provider: "spice", horizon_model: "ideal_geometric", body_fixed_frame: "MOON_ME", time_scale_note: "", kernel_set: [] },
    data_provenance: [],
    assumptions: [],
    warnings: [],
    samples,
    windows: { sun_visible: sun, earth_visible: earth },
  };
}

describe("interval helpers", () => {
  const s = (a: number, b: number) => ({ start: h(a), end: h(b) });

  it("unites overlapping and touching spans", () => {
    expect(unite([s(5, 7), s(0, 2), s(1, 3), s(3, 4)])).toEqual([s(0, 4), s(5, 7)]);
  });

  it("intersects two lists", () => {
    expect(intersect([s(0, 10)], [s(2, 3), s(8, 12)])).toEqual([s(2, 3), s(8, 10)]);
    expect(intersect([s(0, 1)], [s(1, 2)])).toEqual([]);
    expect(intersect([], [s(0, 1)])).toEqual([]);
  });

  it("measures coverage and the longest gap inside the span", () => {
    const spans = [s(2, 4), s(10, 11)];
    expect(covered(spans, h(0), h(12))).toBe(h(3));
    expect(longestGap(spans, h(0), h(12))).toBe(h(6)); // 4 -> 10
    expect(longestGap([], h(0), h(12))).toBe(h(12));
    expect(longestGap([s(-5, 20)], h(0), h(12))).toBe(0);
    expect(covered([s(-5, 1)], h(0), h(12))).toBe(h(1)); // clipped to the span
  });

  it("drops unparsable or empty windows", () => {
    expect(toSpans([{ start_utc: "x", end_utc: at(1), clipped_start: false, clipped_end: false }, win(2, 2)])).toEqual([]);
  });
});

describe("scenarioMetrics", () => {
  it("computes fractions, joint visibility and outages from the windows", () => {
    // 0..24 h. Sun 0-12 (open at start), Earth 6-18.
    const m = scenarioMetrics(response(24, [win(0, 12, true)], [win(6, 18)]))!;
    expect(m.spanHours).toBe(24);
    expect(m.sunFraction).toBeCloseTo(0.5, 12);
    expect(m.earthFraction).toBeCloseTo(0.5, 12);
    expect(m.jointFraction).toBeCloseTo(0.25, 12); // 6-12
    expect(m.longestSunOutageHours).toBeCloseTo(12, 9);
    expect(m.longestEarthOutageHours).toBeCloseTo(6, 9);
    expect(m.longestJointOutageHours).toBeCloseTo(12, 9); // 12-24
    expect(m.firstSunriseUtc).toBeNull(); // already up at the first sample
    expect(m.firstEarthriseUtc).toBe(at(6));
  });

  it("is null without samples (not_ready)", () => {
    expect(scenarioMetrics({ ...response(0, [], []), samples: [] })).toBeNull();
    expect(scenarioMetrics(response(0, [], []))).toBeNull(); // one sample, zero span
  });

  it("never visible: zero fractions, outage = whole span", () => {
    const m = scenarioMetrics(response(10, [], []))!;
    expect(m.sunFraction).toBe(0);
    expect(m.jointFraction).toBe(0);
    expect(m.longestJointOutageHours).toBe(10);
  });
});

describe("scenarioB", () => {
  const a: ScenarioRequest = {
    site: { latitude_deg: -89.5, longitude_deg: 0, observer_height_m: 2 },
    start_utc: "2026-11-15T00:00:00Z",
    duration_hours: 72,
    step_minutes: 10,
    terrain_mode: "ideal",
  };

  it("keeps A's grid and height, changes the site and shifts the start", () => {
    const b = scenarioB(a, { latitude_deg: -88, longitude_deg: 45, shiftDays: 3 });
    expect(b.start_utc).toBe("2026-11-18T00:00:00Z");
    expect(b.site).toEqual({ latitude_deg: -88, longitude_deg: 45, observer_height_m: 2 });
    expect(b.duration_hours).toBe(72);
    expect(b.step_minutes).toBe(10);
    expect(b.terrain_mode).toBe("ideal");
    expect(a.start_utc).toBe("2026-11-15T00:00:00Z"); // A untouched
  });

  it("handles negative and fractional shifts, output matches the UTC pattern", () => {
    expect(scenarioB(a, { latitude_deg: 0, longitude_deg: 0, shiftDays: -1.5 }).start_utc).toBe("2026-11-13T12:00:00Z");
    expect(scenarioB(a, { latitude_deg: 0, longitude_deg: 0, shiftDays: 0 }).start_utc).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
  });
});
