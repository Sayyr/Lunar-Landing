import { useState } from "react";

import { api, ApiError } from "../api/client";
import type { ScenarioRequest } from "../api/types";
import { scenarioB, scenarioMetrics } from "../lib/compare";
import { type Constraints, type DelayPoint, delayShifts, mapLimit, MAX_DELAY_POINTS, NO_CONSTRAINTS, rank, spread } from "../lib/delay";
import { formatDuration } from "../lib/radio";

const W = 720;
const H = 200;
const PAD = { l: 44, r: 12, t: 12, b: 28 };
const pct = (x: number) => `${(x * 100).toFixed(1)} %`;

function describe(e: unknown): string {
  if (e instanceof ApiError && e.body) return `${e.body.error.code}: ${e.body.error.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** Visibility fractions versus landing delay. */
function DelayChart({ points, failed }: { points: DelayPoint[]; failed: Set<number> }) {
  const ok = points.filter((p) => p.metrics);
  if (ok.length < 2) return null;
  const d0 = ok[0].shiftDays;
  const d1 = ok[ok.length - 1].shiftDays;
  const x = (d: number) => PAD.l + ((d - d0) / (d1 - d0)) * (W - PAD.l - PAD.r);
  const y = (f: number) => PAD.t + (1 - f) * (H - PAD.t - PAD.b);
  const path = (pick: (p: DelayPoint) => number) => ok.map((p, i) => `${i ? "L" : "M"}${x(p.shiftDays).toFixed(1)},${y(pick(p)).toFixed(1)}`).join("");
  const every = Math.max(1, Math.ceil(ok.length / 10));
  return (
    <svg className="timeline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Visibility fractions versus landing delay">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line className="horizon" x1={PAD.l} x2={W - PAD.r} y1={y(f)} y2={y(f)} />
          <text className="axis" x={PAD.l - 6} y={y(f) + 4} textAnchor="end">{f * 100} %</text>
        </g>
      ))}
      <path className="line-sun" d={path((p) => p.metrics!.sunFraction)} />
      <path className="line-earth" d={path((p) => p.metrics!.earthFraction)} />
      <path className="line-joint" d={path((p) => p.metrics!.jointFraction)} />
      {ok.map((p, i) => (
        <g key={p.shiftDays}>
          <circle className={failed.has(p.shiftDays) ? "dot-fail" : "dot-pass"} cx={x(p.shiftDays)} cy={y(p.metrics!.jointFraction)} r={3} />
          {i % every === 0 && (
            <text className="axis" x={x(p.shiftDays)} y={H - 8} textAnchor="middle">+{p.shiftDays} d</text>
          )}
        </g>
      ))}
    </svg>
  );
}

/**
 * Delay robustness of the current scenario: the same site and duration evaluated at start + delay
 * for a range of delays (real SPICE ephemerides), with user constraints and an explicit ordering.
 */
export function DelaySweepPanel({ scenario }: { scenario: ScenarioRequest }) {
  const [maxDays, setMaxDays] = useState(14);
  const [stepDays, setStepDays] = useState(1);
  const [c, setC] = useState<Constraints>(NO_CONSTRAINTS);
  const [order, setOrder] = useState<"delay" | "ranked">("delay");
  const [busy, setBusy] = useState<string | null>(null);
  const [run, setRun] = useState<{ request: ScenarioRequest; points: DelayPoint[] } | null>(null);

  const shifts = delayShifts(maxDays, stepDays);
  const sweep = async () => {
    const request = scenario;
    let done = 0;
    setBusy(`0 / ${shifts.length}`);
    const points = await mapLimit(shifts, 4, async (shiftDays): Promise<DelayPoint> => {
      const req = scenarioB(request, { latitude_deg: request.site.latitude_deg, longitude_deg: request.site.longitude_deg, shiftDays });
      let point: DelayPoint;
      try {
        const r = await api.evaluate(req);
        const metrics = r.status === "computed" ? scenarioMetrics(r) : null;
        point = { shiftDays, startUtc: req.start_utc, metrics, note: metrics ? "" : r.status === "computed" ? "fewer than two samples" : r.message };
      } catch (e) {
        point = { shiftDays, startUtc: req.start_utc, metrics: null, note: describe(e) };
      }
      setBusy(`${++done} / ${shifts.length}`);
      return point;
    });
    setRun({ request, points });
    setBusy(null);
  };

  // Percent / hours inputs; an empty field removes the constraint.
  const bound = (key: keyof Constraints, label: string, scale: number) => (
    <label>
      {label}
      <input
        type="number"
        min={0}
        step={scale === 100 ? 5 : 1}
        placeholder="none"
        value={c[key] === null ? "" : Math.round(c[key]! * scale * 1000) / 1000}
        onChange={(e) => setC((s) => ({ ...s, [key]: e.target.value === "" || !Number.isFinite(e.target.valueAsNumber) ? null : e.target.valueAsNumber / scale }))}
      />
    </label>
  );

  const ranked = run ? rank(run.points, c) : [];
  const failed = new Set(ranked.filter((p) => p.violations.length).map((p) => p.shiftDays));
  const computed = ranked.filter((p) => p.metrics);
  const passing = computed.filter((p) => !p.violations.length);
  const rows = order === "ranked" ? ranked : [...ranked].sort((a, b) => a.shiftDays - b.shiftDays);
  const anyConstraint = Object.values(c).some((v) => v !== null);
  const stat = (label: string, pick: (m: NonNullable<DelayPoint["metrics"]>) => number, show: (v: number) => string, worstIsMin: boolean) => {
    const s = run && spread(run.points, pick);
    if (!s) return null;
    return (
      <tr key={label}>
        <th scope="row">{label}</th>
        <td>{show(worstIsMin ? s.min : s.max)} <span className="muted">(+{worstIsMin ? s.minAtDays : s.maxAtDays} d)</span></td>
        <td>{show(worstIsMin ? s.max : s.min)} <span className="muted">(+{worstIsMin ? s.maxAtDays : s.minAtDays} d)</span></td>
        <td>{show(s.mean)}</td>
        <td>{show(s.std)}</td>
      </tr>
    );
  };

  return (
    <details className="compare delay">
      <summary>Delay robustness — what if the landing slips?</summary>
      <p className="muted small">
        Evaluates the scenario above at start + delay for each delay (same site, duration, step; real SPICE ephemerides,
        ideal geometric horizon). Reports the worst case and the spread, and checks the constraints you set. Geometric
        visibility only: not power, not a radio link, no terrain.
      </p>
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <div className="grid2">
          <label>
            Maximum delay (days)
            <input type="number" min={0} max={365} step={1} value={maxDays} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && setMaxDays(e.target.valueAsNumber)} />
          </label>
          <label>
            Delay step (days)
            <input type="number" min={0.25} step={0.25} value={stepDays} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && setStepDays(e.target.valueAsNumber)} />
          </label>
          {bound("minSunFraction", "Min. Sun above horizon (%)", 100)}
          {bound("minEarthFraction", "Min. Earth above horizon (%)", 100)}
          {bound("minJointFraction", "Min. Sun AND Earth (%)", 100)}
          {bound("maxSunOutageHours", "Max. Sun outage (h)", 1)}
          {bound("maxEarthOutageHours", "Max. Earth outage (h)", 1)}
        </div>
        <div className="actions">
          <button type="button" disabled={busy !== null} onClick={sweep}>
            {busy !== null ? `Evaluating ${busy}…` : `Evaluate ${shifts.length} delays`}
          </button>
        </div>
        {shifts.length === MAX_DELAY_POINTS && <p className="muted small">Capped at {MAX_DELAY_POINTS} delays: increase the step to cover the whole range.</p>}
      </form>

      {run && (
        <section className="result">
          {computed.length === 0 ? (
            <div className="error" role="alert">No delay could be computed: {run.points[0]?.note || "no result"}</div>
          ) : (
            <>
              <p>
                {anyConstraint ? (
                  <>
                    <b>{passing.length} of {computed.length}</b> delays meet every constraint
                    {passing.length > 0 && passing.length < computed.length && <> (delays: {passing.map((p) => `+${p.shiftDays}`).sort((a, b) => Number(a) - Number(b)).join(", ")} d)</>}.
                  </>
                ) : (
                  <>No constraint set: all {computed.length} computed delays are listed. Set bounds above to test them.</>
                )}
              </p>
              <div className="legend">
                <span className="sw sun" /> Sun <span className="sw earth" /> Earth <span className="sw joint" /> Sun AND Earth
                <span className="muted"> · fraction of the {formatDuration(computed[0].metrics!.spanHours)} span above the ideal horizon; dots: constraint met / violated</span>
              </div>
              <DelayChart points={run.points} failed={failed} />
              <table className="compare-table">
                <thead>
                  <tr><th>Over all delays</th><th>Worst</th><th>Best</th><th>Mean</th><th>Std dev.</th></tr>
                </thead>
                <tbody>
                  {stat("Sun above horizon", (m) => m.sunFraction, pct, true)}
                  {stat("Earth above horizon", (m) => m.earthFraction, pct, true)}
                  {stat("Sun AND Earth", (m) => m.jointFraction, pct, true)}
                  {stat("Longest Sun outage", (m) => m.longestSunOutageHours, formatDuration, false)}
                  {stat("Longest Earth outage", (m) => m.longestEarthOutageHours, formatDuration, false)}
                </tbody>
              </table>
            </>
          )}
          <div className="actions">
            <button type="button" className={order === "delay" ? "active" : ""} onClick={() => setOrder("delay")}>By delay</button>
            <button type="button" className={order === "ranked" ? "active" : ""} onClick={() => setOrder("ranked")}>Ranked</button>
          </div>
          {order === "ranked" && (
            <p className="muted small">
              Order: delays meeting every constraint first; then most time with Sun AND Earth visible; then shortest stretch
              without both; then smallest delay. No weighted score.
            </p>
          )}
          <table className="compare-table delay-table">
            <thead>
              <tr><th>Delay</th><th>Start (UTC)</th><th>Sun</th><th>Earth</th><th>Both</th><th>Sun out.</th><th>Earth out.</th><th>Rank</th><th>Constraints</th></tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.shiftDays} className={p.metrics ? (p.violations.length ? "row-fail" : "") : "row-na"}>
                  <th scope="row">+{p.shiftDays} d</th>
                  <td>{p.startUtc.slice(0, 16).replace("T", " ")}</td>
                  {p.metrics ? (
                    <>
                      <td>{pct(p.metrics.sunFraction)}</td>
                      <td>{pct(p.metrics.earthFraction)}</td>
                      <td>{pct(p.metrics.jointFraction)}</td>
                      <td>{formatDuration(p.metrics.longestSunOutageHours)}</td>
                      <td>{formatDuration(p.metrics.longestEarthOutageHours)}</td>
                      <td>{p.rank}</td>
                      <td className="reasons">{p.violations.length ? p.violations.join("; ") : anyConstraint ? "met" : "—"}</td>
                    </>
                  ) : (
                    <td colSpan={7} className="reasons">not computed: {p.note}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Each row covers {run.request.duration_hours} h from its own start. Outages touching the edges of that span are
            lower bounds. A delay between two sampled delays is not covered: reduce the step to check it.
          </p>
        </section>
      )}
    </details>
  );
}
