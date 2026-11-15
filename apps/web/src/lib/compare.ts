// Scenario comparison metrics (SCIENTIFIC_REFERENCE.md section 9), computed from the visibility
// WINDOWS returned by the science service. Only interval bookkeeping happens here: no ephemeris,
// no geometry. Every value covers the sampled span [first sample, last sample].
import type { ScenarioRequest, ScenarioResponse, VisibilityWindow } from "../api/types";

export interface Span {
  start: number; // ms since epoch
  end: number;
}

export interface ScenarioMetrics {
  spanHours: number;
  sunFraction: number;
  earthFraction: number;
  /** Sun AND Earth above the horizon at the same time (intersection of the two window sets) */
  jointFraction: number;
  longestSunOutageHours: number;
  longestEarthOutageHours: number;
  longestJointOutageHours: number;
  sunWindows: number;
  earthWindows: number;
  /** first window start that is NOT already open at the first sample, or null */
  firstSunriseUtc: string | null;
  firstEarthriseUtc: string | null;
}

export function toSpans(windows: VisibilityWindow[]): Span[] {
  return windows
    .map((w) => ({ start: Date.parse(w.start_utc), end: Date.parse(w.end_utc) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
}

/** Sorted, disjoint union. */
export function unite(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** Intersection of two lists (each made disjoint first). */
export function intersect(a: Span[], b: Span[]): Span[] {
  const x = unite(a);
  const y = unite(b);
  const out: Span[] = [];
  for (let i = 0, j = 0; i < x.length && j < y.length; ) {
    const start = Math.max(x[i].start, y[j].start);
    const end = Math.min(x[i].end, y[j].end);
    if (start < end) out.push({ start, end });
    if (x[i].end < y[j].end) i++;
    else j++;
  }
  return out;
}

/** Covered length of `spans` inside [t0, t1], ms. */
export function covered(spans: Span[], t0: number, t1: number): number {
  return unite(spans).reduce((sum, s) => sum + Math.max(0, Math.min(s.end, t1) - Math.max(s.start, t0)), 0);
}

/** Longest stretch of [t0, t1] not covered by `spans`, ms. */
export function longestGap(spans: Span[], t0: number, t1: number): number {
  let longest = 0;
  let cursor = t0;
  for (const s of unite(spans)) {
    if (s.end <= t0 || s.start >= t1) continue;
    longest = Math.max(longest, Math.max(s.start, t0) - cursor);
    cursor = Math.max(cursor, Math.min(s.end, t1));
  }
  return Math.max(longest, t1 - cursor);
}

const H = 3.6e6;

/** null when the response carries no computed samples (not_ready) or spans a single instant. */
export function scenarioMetrics(r: ScenarioResponse): ScenarioMetrics | null {
  if (r.samples.length < 2) return null;
  const t0 = Date.parse(r.samples[0].utc);
  const t1 = Date.parse(r.samples[r.samples.length - 1].utc);
  if (!(t1 > t0)) return null;
  const sun = toSpans(r.windows.sun_visible);
  const earth = toSpans(r.windows.earth_visible);
  const joint = intersect(sun, earth);
  const T = t1 - t0;
  const firstRise = (w: VisibilityWindow[]) => w.find((x) => !x.clipped_start)?.start_utc ?? null;
  return {
    spanHours: T / H,
    sunFraction: covered(sun, t0, t1) / T,
    earthFraction: covered(earth, t0, t1) / T,
    jointFraction: covered(joint, t0, t1) / T,
    longestSunOutageHours: longestGap(sun, t0, t1) / H,
    longestEarthOutageHours: longestGap(earth, t0, t1) / H,
    longestJointOutageHours: longestGap(joint, t0, t1) / H,
    sunWindows: r.windows.sun_visible.length,
    earthWindows: r.windows.earth_visible.length,
    firstSunriseUtc: firstRise(r.windows.sun_visible),
    firstEarthriseUtc: firstRise(r.windows.earth_visible),
  };
}

/** Scenario B: A's request with another site and/or a start shifted by `shiftDays`. */
export function scenarioB(
  a: ScenarioRequest,
  b: { latitude_deg: number; longitude_deg: number; shiftDays: number },
): ScenarioRequest {
  const start = new Date(Date.parse(a.start_utc) + b.shiftDays * 86_400_000);
  return {
    ...a,
    site: { ...a.site, latitude_deg: b.latitude_deg, longitude_deg: b.longitude_deg },
    // Same format as the form produces: seconds precision, literal Z (schema pattern).
    start_utc: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}
