// Delay robustness (SCIENTIFIC_REFERENCE.md sections 9 and 12): the same scenario evaluated at
// start + delay, for a range of delays. This file only does bookkeeping on the metrics computed from
// the science service's windows (lib/compare.ts): explicit constraints, worst case and spread, and a
// transparent ordering. There is no hidden score and no weighting.
import type { ScenarioMetrics } from "./compare";

export const MAX_DELAY_POINTS = 61;

/** 0, step, 2·step … up to maxDays inclusive (capped at MAX_DELAY_POINTS values). */
export function delayShifts(maxDays: number, stepDays: number): number[] {
  if (!(maxDays >= 0) || !(stepDays > 0)) return [0];
  const n = Math.min(MAX_DELAY_POINTS, Math.floor(maxDays / stepDays + 1e-9) + 1);
  return Array.from({ length: n }, (_, i) => Math.round(i * stepDays * 1e6) / 1e6);
}

/** User-defined hard constraints. A null bound is not applied. Fractions in 0..1, outages in hours. */
export interface Constraints {
  minSunFraction: number | null;
  minEarthFraction: number | null;
  minJointFraction: number | null;
  maxSunOutageHours: number | null;
  maxEarthOutageHours: number | null;
}

export const NO_CONSTRAINTS: Constraints = {
  minSunFraction: null,
  minEarthFraction: null,
  minJointFraction: null,
  maxSunOutageHours: null,
  maxEarthOutageHours: null,
};

const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
const hrs = (x: number) => `${x.toFixed(1)} h`;

/** Every violated constraint, in plain words (empty = all constraints met). */
export function violations(m: ScenarioMetrics, c: Constraints): string[] {
  const out: string[] = [];
  const min = (bound: number | null, value: number, label: string) => {
    if (bound !== null && value < bound) out.push(`${label} ${pct(value)} < ${pct(bound)}`);
  };
  const max = (bound: number | null, value: number, label: string) => {
    if (bound !== null && value > bound) out.push(`${label} ${hrs(value)} > ${hrs(bound)}`);
  };
  min(c.minSunFraction, m.sunFraction, "Sun");
  min(c.minEarthFraction, m.earthFraction, "Earth");
  min(c.minJointFraction, m.jointFraction, "Sun+Earth");
  max(c.maxSunOutageHours, m.longestSunOutageHours, "Sun outage");
  max(c.maxEarthOutageHours, m.longestEarthOutageHours, "Earth outage");
  return out;
}

export interface DelayPoint {
  shiftDays: number;
  startUtc: string;
  /** null when the scenario was not computed (not_ready or request error); `note` says why */
  metrics: ScenarioMetrics | null;
  note: string;
}

export interface Spread {
  min: number;
  max: number;
  mean: number;
  /** population standard deviation */
  std: number;
  /** delay (days) at which the minimum / maximum occurs (first occurrence) */
  minAtDays: number;
  maxAtDays: number;
}

export function spread(points: DelayPoint[], pick: (m: ScenarioMetrics) => number): Spread | null {
  const rows = points.filter((p) => p.metrics).map((p) => ({ d: p.shiftDays, v: pick(p.metrics!) }));
  if (!rows.length) return null;
  const mean = rows.reduce((s, r) => s + r.v, 0) / rows.length;
  const lo = rows.reduce((a, b) => (b.v < a.v ? b : a));
  const hi = rows.reduce((a, b) => (b.v > a.v ? b : a));
  return {
    min: lo.v,
    max: hi.v,
    mean,
    std: Math.sqrt(rows.reduce((s, r) => s + (r.v - mean) ** 2, 0) / rows.length),
    minAtDays: lo.d,
    maxAtDays: hi.d,
  };
}

export interface RankedPoint extends DelayPoint {
  violations: string[];
  /** 1-based position among the computed points; null when not computed */
  rank: number | null;
}

/**
 * Explicit ordering, stated in the UI: (1) delays meeting every constraint come first; (2) then by
 * time with Sun AND Earth visible, highest first; (3) then by shortest Sun-and-Earth outage;
 * (4) then by smallest delay. Points that were not computed are listed last, unranked.
 */
export function rank(points: DelayPoint[], c: Constraints): RankedPoint[] {
  const computed = points
    .filter((p) => p.metrics)
    .map((p) => ({ ...p, violations: violations(p.metrics!, c), rank: null as number | null }));
  computed.sort(
    (a, b) =>
      Number(a.violations.length > 0) - Number(b.violations.length > 0) ||
      b.metrics!.jointFraction - a.metrics!.jointFraction ||
      a.metrics!.longestJointOutageHours - b.metrics!.longestJointOutageHours ||
      a.shiftDays - b.shiftDays,
  );
  computed.forEach((p, i) => (p.rank = i + 1));
  const failed = points.filter((p) => !p.metrics).map((p) => ({ ...p, violations: [], rank: null }));
  return [...computed, ...failed];
}

/** Runs `task` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await task(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
