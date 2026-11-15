import { useState } from "react";

import { api, ApiError } from "../api/client";
import type { ScenarioRequest, ScenarioResponse } from "../api/types";
import { type ScenarioMetrics, scenarioB, scenarioMetrics } from "../lib/compare";
import { formatDuration } from "../lib/radio";
import { Timeline } from "./Timeline";

type Outcome = { response: ScenarioResponse; metrics: ScenarioMetrics | null } | { error: string };

function describe(e: unknown): string {
  if (e instanceof ApiError && e.body) {
    const d = e.body.error.details.map((x) => `${x.field}: ${x.issue}`).join("; ");
    return `${e.body.error.code}: ${e.body.error.message}${d ? ` (${d})` : ""}`;
  }
  return e instanceof Error ? e.message : String(e);
}

const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
const signed = (x: number, unit: string, digits = 1) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x).toFixed(digits)}${unit}`;
const utc = (s: string | null) => (s ? `${s.slice(0, 16).replace("T", " ")}Z` : "—");

interface Row {
  label: string;
  show: (m: ScenarioMetrics) => string;
  /** B − A; absent when a difference is not meaningful */
  diff?: (a: ScenarioMetrics, b: ScenarioMetrics) => string;
}
const ROWS: Row[] = [
  { label: "Sun above horizon", show: (m) => pct(m.sunFraction), diff: (a, b) => signed((b.sunFraction - a.sunFraction) * 100, " pt") },
  { label: "Earth above horizon", show: (m) => pct(m.earthFraction), diff: (a, b) => signed((b.earthFraction - a.earthFraction) * 100, " pt") },
  { label: "Sun AND Earth", show: (m) => pct(m.jointFraction), diff: (a, b) => signed((b.jointFraction - a.jointFraction) * 100, " pt") },
  { label: "Longest Sun outage", show: (m) => formatDuration(m.longestSunOutageHours), diff: (a, b) => signed(b.longestSunOutageHours - a.longestSunOutageHours, " h") },
  { label: "Longest Earth outage", show: (m) => formatDuration(m.longestEarthOutageHours), diff: (a, b) => signed(b.longestEarthOutageHours - a.longestEarthOutageHours, " h") },
  { label: "Longest time without Sun AND Earth", show: (m) => formatDuration(m.longestJointOutageHours), diff: (a, b) => signed(b.longestJointOutageHours - a.longestJointOutageHours, " h") },
  { label: "Sun windows", show: (m) => String(m.sunWindows), diff: (a, b) => signed(b.sunWindows - a.sunWindows, "", 0) },
  { label: "Earth windows", show: (m) => String(m.earthWindows), diff: (a, b) => signed(b.earthWindows - a.earthWindows, "", 0) },
  { label: "First sunrise", show: (m) => utc(m.firstSunriseUtc) },
  { label: "First Earthrise", show: (m) => utc(m.firstEarthriseUtc) },
];

function Side({ label, req, out }: { label: string; req: ScenarioRequest; out: Outcome }) {
  return (
    <div className="compare-side">
      <h4>
        {label} · {req.site.latitude_deg.toFixed(3)}°, {req.site.longitude_deg.toFixed(3)}°E · from {utc(req.start_utc)}
      </h4>
      {"error" in out ? (
        <div className="error" role="alert">{out.error}</div>
      ) : (
        <>
          <span className={`status status-${out.response.status}`}>{out.response.status.replace("_", " ")}</span>
          {out.response.status !== "computed" && <span className="small"> {out.response.message}</span>}
          <Timeline
            samples={out.response.samples}
            sunWindows={out.response.windows.sun_visible}
            earthWindows={out.response.windows.earth_visible}
            watermark={out.response.synthetic ? "SYNTHETIC" : undefined}
          />
        </>
      )}
    </div>
  );
}

/**
 * Side-by-side comparison of scenario A (the current form) and scenario B (another site and/or a
 * start shifted by N days: the delay case). Both are evaluated by the science service; this panel
 * only compares the returned windows.
 */
export function ComparePanel({ scenario }: { scenario: ScenarioRequest }) {
  const [b, setB] = useState({ latitude_deg: scenario.site.latitude_deg, longitude_deg: scenario.site.longitude_deg, shiftDays: 3 });
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<{ reqA: ScenarioRequest; reqB: ScenarioRequest; a: Outcome; b: Outcome } | null>(null);

  const reqB = scenarioB(scenario, b);
  const compare = async () => {
    setBusy(true);
    const reqA = scenario;
    const settle = (p: Promise<ScenarioResponse>): Promise<Outcome> =>
      p.then((response) => ({ response, metrics: scenarioMetrics(response) }), (e) => ({ error: describe(e) }));
    const [a, bb] = await Promise.all([settle(api.evaluate(reqA)), settle(api.evaluate(reqB))]);
    setRun({ reqA, reqB, a, b: bb });
    setBusy(false);
  };

  const num = (key: keyof typeof b, step: number, label: string, min: number, max: number) => (
    <label>
      {label}
      <input type="number" value={b[key]} step={step} min={min} max={max}
        onChange={(e) => Number.isFinite(e.target.valueAsNumber) && setB((s) => ({ ...s, [key]: e.target.valueAsNumber }))} />
    </label>
  );

  const ma = run && !("error" in run.a) ? run.a.metrics : null;
  const mb = run && !("error" in run.b) ? run.b.metrics : null;
  const bothComputed = run && !("error" in run.a) && !("error" in run.b) && run.a.response.status === "computed" && run.b.response.status === "computed";
  const anySynthetic = run && [run.a, run.b].some((o) => !("error" in o) && o.response.synthetic);

  return (
    <details className="compare">
      <summary>Compare with scenario B</summary>
      <p className="muted small">
        A = the scenario above. B = same duration, step, height and horizon model, at another site and/or a start shifted by N
        days (a landing delay). Both use real SPICE ephemerides; geometric visibility only, not power or link availability.
      </p>
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <div className="grid2">
          {num("latitude_deg", 0.1, "B latitude (°)", -90, 90)}
          {num("longitude_deg", 0.1, "B longitude (°E)", -180, 179.999)}
          {num("shiftDays", 0.5, "B start shift (days)", -60, 60)}
          <label>
            B start (UTC)
            <input type="text" readOnly value={reqB.start_utc} />
          </label>
        </div>
        <div className="actions">
          <button type="button" disabled={busy} onClick={compare}>{busy ? "Evaluating A and B…" : "Compare A and B"}</button>
          <button type="button" onClick={() => setB((s) => ({ ...s, latitude_deg: scenario.site.latitude_deg, longitude_deg: scenario.site.longitude_deg }))}>
            B site = A site
          </button>
        </div>
      </form>

      {run && (
        <section className="result">
          {anySynthetic && <div className="synthetic-banner" role="alert">SYNTHETIC data in this comparison — not the real Sun or Earth.</div>}
          {ma && mb && bothComputed ? (
            <table className="compare-table">
              <thead>
                <tr><th /><th>A</th><th>B</th><th>B − A</th></tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td>{row.show(ma)}</td>
                    <td>{row.show(mb)}</td>
                    <td>{row.diff ? row.diff(ma, mb) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">No comparison table: both scenarios must be computed from real ephemerides.</p>
          )}
          <p className="muted small">
            Over the sampled span of each scenario ({ma ? formatDuration(ma.spanHours) : "—"}). Outages at the span edges are lower
            bounds (the window may continue outside it). Body centres, horizon model of the scenario above (ideal: no terrain; DEM: terrain horizon).
          </p>
          <Side label="A" req={run.reqA} out={run.a} />
          <Side label="B" req={run.reqB} out={run.b} />
        </section>
      )}
    </details>
  );
}
