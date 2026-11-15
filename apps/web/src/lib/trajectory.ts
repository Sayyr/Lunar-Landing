// Bookkeeping for drawing a computed trajectory (POST /trajectory/simulate): no physics here.
import type { TrajectoryRequest, TrajectoryResponse } from "../api/trajectoryTypes";

export interface TrajectoryPoint {
  t: number; // ms since epoch
  p: [number, number, number]; // ECLIPJ2000 metres
  phase: "transfer" | "descent";
}

/** All samples in time order (segments are consecutive; a shared boundary sample is kept once). */
export function trajectoryPoints(r: TrajectoryResponse): TrajectoryPoint[] {
  const out: TrajectoryPoint[] = [];
  for (const s of r.segments)
    s.utc.forEach((u, i) => {
      const t = Date.parse(u);
      if (out.length && t <= out[out.length - 1].t) return;
      out.push({ t, p: s.positions_m[i], phase: s.phase });
    });
  return out;
}

/**
 * Position at time t, linearly interpolated between the tool's samples (display only: the tool's
 * samples are minutes apart, much finer than what the view resolves). null outside the span.
 */
export function positionAt(points: TrajectoryPoint[], t: number): TrajectoryPoint | null {
  if (points.length === 0 || t < points[0].t || t > points[points.length - 1].t) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return { t, phase: f < 1 ? a.phase : b.phase, p: [a.p[0] + f * (b.p[0] - a.p[0]), a.p[1] + f * (b.p[1] - a.p[1]), a.p[2] + f * (b.p[2] - a.p[2])] };
}

/** Start of the descent (end of the free transfer), or null. */
export function arrivalUtc(r: TrajectoryResponse): string | null {
  return r.segments.find((s) => s.phase === "descent")?.utc[0] ?? r.segments[0]?.utc.at(-1) ?? null;
}

/** A computed trajectory ready to draw (shared by the Mission page and the Sun · Earth · Moon page). */
export interface TrajectoryView {
  response: TrajectoryResponse;
  points: TrajectoryPoint[];
  /** the mission it was computed for, when there is one */
  mission?: { label: string; landingUtc: string };
}

export const toTrajectoryView = (response: TrajectoryResponse, mission?: TrajectoryView["mission"]): TrajectoryView => ({
  response,
  points: trajectoryPoints(response),
  mission,
});

const DAY_MS = 86_400_000;

/**
 * Departure for a mission: its landing minus the target transfer duration, rounded to the minute
 * (the tool then searches the transfer duration within ± 2 days, so the computed arrival is not
 * forced to the planned landing: compare them with landingGapHours).
 */
export function missionDepartureUtc(landingUtc: string, transferDays: number): string {
  const t = Math.round((Date.parse(landingUtc) - transferDays * DAY_MS) / 60_000) * 60_000;
  return `${new Date(t).toISOString().slice(0, 19)}Z`;
}

/** End of the computed trajectory (end of descent) minus the planned landing, hours. */
export function landingGapHours(v: TrajectoryView, landingUtc: string): number | null {
  const end = v.points.at(-1);
  return end ? (end.t - Date.parse(landingUtc)) / 3_600_000 : null;
}

/** Re-runs that shift the departure by the measured gap, to bring the end of descent onto the landing. */
export const MATCH_TRIES = 3;
export const MATCH_HOURS = 1;

/**
 * Trajectory for a mission: depart `transferDays` before its landing, then — since the tool picks the
 * transfer duration itself — shift the departure by the end-vs-landing gap and run again (at most
 * MATCH_TRIES runs, stopping within MATCH_HOURS), keeping the closest result. `simulate` is the API
 * call (injected for tests). Throws with the tool's message when no run gives a trajectory.
 */
export async function computeMissionTrajectory(
  simulate: (req: TrajectoryRequest) => Promise<TrajectoryResponse>,
  m: { name: string; site: { latitude_deg: number; longitude_deg: number }; landingUtc: string; transferDays: number },
  onProgress?: (text: string) => void,
): Promise<{ view: TrajectoryView; gapHours: number; runs: number }> {
  let dep = missionDepartureUtc(m.landingUtc, m.transferDays);
  let best: { view: TrajectoryView; gapHours: number; runs: number } | null = null;
  let failure = "";
  for (let i = 1; i <= MATCH_TRIES; i++) {
    onProgress?.(`run ${i}/${MATCH_TRIES}, departure ${dep.slice(0, 16).replace("T", " ")} UTC`);
    const r = await simulate({ site: m.site, departure_utc: dep, transfer_days: m.transferDays });
    if (r.status !== "computed") {
      failure = `${r.status}: ${r.message}`;
      break;
    }
    const view = toTrajectoryView(r, { label: m.name, landingUtc: m.landingUtc });
    const gap = landingGapHours(view, m.landingUtc) ?? 0;
    if (!best || Math.abs(gap) < Math.abs(best.gapHours)) best = { view, gapHours: gap, runs: i };
    if (Math.abs(gap) <= MATCH_HOURS) break;
    const next = `${new Date(Math.round((Date.parse(dep) - gap * 3_600_000) / 60_000) * 60_000).toISOString().slice(0, 19)}Z`;
    if (next === dep) break;
    dep = next;
  }
  if (!best) throw new Error(failure || "no trajectory");
  return best;
}
