import { describe, expect, it } from "vitest";

import type { ScenarioMetrics } from "./compare";
import { delayShifts, type DelayPoint, mapLimit, MAX_DELAY_POINTS, NO_CONSTRAINTS, rank, spread, violations } from "./delay";

const metrics = (over: Partial<ScenarioMetrics>): ScenarioMetrics => ({
  spanHours: 72,
  sunFraction: 1,
  earthFraction: 0.5,
  jointFraction: 0.5,
  longestSunOutageHours: 0,
  longestEarthOutageHours: 36,
  longestJointOutageHours: 36,
  sunWindows: 1,
  earthWindows: 1,
  firstSunriseUtc: null,
  firstEarthriseUtc: null,
  ...over,
});
const point = (shiftDays: number, over: Partial<ScenarioMetrics> | null): DelayPoint => ({
  shiftDays,
  startUtc: "",
  metrics: over ? metrics(over) : null,
  note: over ? "" : "not_ready",
});

describe("delayShifts", () => {
  it("includes 0 and the maximum when it falls on the grid", () => {
    expect(delayShifts(3, 1)).toEqual([0, 1, 2, 3]);
    expect(delayShifts(1, 0.5)).toEqual([0, 0.5, 1]);
    expect(delayShifts(2.9, 1)).toEqual([0, 1, 2]);
    expect(delayShifts(0.3, 0.1)).toEqual([0, 0.1, 0.2, 0.3]); // no float drift
  });
  it("is capped and tolerates bad input", () => {
    expect(delayShifts(1000, 1)).toHaveLength(MAX_DELAY_POINTS);
    expect(delayShifts(-1, 1)).toEqual([0]);
    expect(delayShifts(5, 0)).toEqual([0]);
    expect(delayShifts(NaN, 1)).toEqual([0]);
  });
});

describe("violations", () => {
  it("reports nothing without constraints", () => {
    expect(violations(metrics({}), NO_CONSTRAINTS)).toEqual([]);
  });
  it("names each violated bound with both values", () => {
    const v = violations(metrics({ earthFraction: 0.2, longestEarthOutageHours: 50 }), {
      ...NO_CONSTRAINTS,
      minEarthFraction: 0.4,
      maxEarthOutageHours: 24,
      minSunFraction: 0.9, // met
    });
    expect(v).toEqual(["Earth 20.0 % < 40.0 %", "Earth outage 50.0 h > 24.0 h"]);
  });
  it("a value equal to the bound passes", () => {
    expect(violations(metrics({ earthFraction: 0.4 }), { ...NO_CONSTRAINTS, minEarthFraction: 0.4 })).toEqual([]);
  });
});

describe("spread", () => {
  it("gives worst case, best case, mean and standard deviation over computed points", () => {
    const s = spread([point(0, { earthFraction: 0.2 }), point(1, { earthFraction: 0.6 }), point(2, null), point(3, { earthFraction: 0.4 })], (m) => m.earthFraction)!;
    expect(s.min).toBe(0.2);
    expect(s.minAtDays).toBe(0);
    expect(s.max).toBe(0.6);
    expect(s.maxAtDays).toBe(1);
    expect(s.mean).toBeCloseTo(0.4, 12);
    expect(s.std).toBeCloseTo(Math.sqrt(0.08 / 3), 12);
  });
  it("is null when nothing was computed", () => {
    expect(spread([point(0, null)], (m) => m.sunFraction)).toBeNull();
  });
});

describe("rank", () => {
  const c = { ...NO_CONSTRAINTS, minEarthFraction: 0.3 };
  const pts = [
    point(0, { earthFraction: 0.2, jointFraction: 0.9 }), // violates: last among computed despite best joint
    point(1, { earthFraction: 0.5, jointFraction: 0.4, longestJointOutageHours: 30 }),
    point(2, { earthFraction: 0.5, jointFraction: 0.6 }),
    point(3, null),
    point(4, { earthFraction: 0.5, jointFraction: 0.4, longestJointOutageHours: 10 }),
    point(5, { earthFraction: 0.5, jointFraction: 0.4, longestJointOutageHours: 10 }),
  ];
  const r = rank(pts, c);

  it("orders by constraints, then joint visibility, then outage, then delay", () => {
    expect(r.map((p) => p.shiftDays)).toEqual([2, 4, 5, 1, 0, 3]);
    expect(r.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5, null]);
  });
  it("keeps the reasons and does not mutate its input", () => {
    expect(r[4].violations).toEqual(["Earth 20.0 % < 30.0 %"]);
    expect(r[5].note).toBe("not_ready");
    expect(pts.map((p) => p.shiftDays)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("mapLimit", () => {
  it("keeps order and never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async (x) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, x));
      inFlight--;
      return x * 10;
    });
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
    expect(await mapLimit([], 4, async (x: number) => x)).toEqual([]);
  });
});
