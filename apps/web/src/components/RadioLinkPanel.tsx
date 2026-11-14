import { useState } from "react";

import { api, ApiError } from "../api/client";
import type { RadioLinkResponse, ScenarioRequest, VisibilityWindow } from "../api/types";
import {
  buildRadioRequest,
  DEFAULT_RADIO_SETTINGS,
  formatDuration,
  formatPercent,
  type RadioSettings,
  STATION_PRESETS,
} from "../lib/radio";

const W = 720;
const PAD = { l: 44, r: 12, t: 10, b: 26 };
const PLOT_H = 130;
const ROW_H = 12;

/** Earth elevation at the site (line) over one availability row per condition (bars). */
function RadioTimeline({ result }: { result: RadioLinkResponse }) {
  const { samples, windows } = result;
  if (samples.length < 2) return null;
  const t = samples.map((s) => Date.parse(s.utc));
  const t0 = t[0];
  const t1 = t[t.length - 1];
  const rows: { label: string; cls: string; windows: VisibilityWindow[] }[] = [
    { label: "Earth", cls: "band-earth", windows: windows.earth_visible },
    ...windows.stations.map((s) => ({ label: s.name.split(/[ ,]/)[0], cls: "band-station", windows: s.windows })),
    { label: "LINK", cls: "band-link", windows: windows.link_available },
  ];
  const H = PAD.t + PLOT_H + 8 + rows.length * ROW_H + PAD.b;
  const yMax = Math.max(1, ...samples.map((s) => Math.abs(s.earth.elevation_deg))) * 1.15;
  const x = (ms: number) => PAD.l + ((ms - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (deg: number) => PAD.t + ((yMax - deg) / (2 * yMax)) * PLOT_H;
  const rowY = (i: number) => PAD.t + PLOT_H + 8 + i * ROW_H;
  const path = samples.map((s, i) => `${i ? "L" : "M"}${x(t[i]).toFixed(1)},${y(s.earth.elevation_deg).toFixed(1)}`).join("");
  const hours = (t1 - t0) / 3.6e6;
  const tickEvery = hours > 480 ? 120 : hours > 96 ? 24 : hours > 24 ? 12 : 6;
  const ticks = Array.from({ length: Math.floor(hours / tickEvery) + 1 }, (_, i) => t0 + i * tickEvery * 3.6e6);
  const mask = result.request.min_earth_elevation_deg;

  return (
    <svg className="timeline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Earth elevation and radio-link windows versus time">
      <line className="horizon" x1={PAD.l} x2={W - PAD.r} y1={y(mask)} y2={y(mask)} />
      <text className="axis" x={PAD.l - 6} y={y(mask) + 4} textAnchor="end">{mask}°</text>
      <text className="axis" x={PAD.l - 6} y={y(yMax / 1.15) + 4} textAnchor="end">{(yMax / 1.15).toFixed(1)}°</text>
      <text className="axis" x={PAD.l - 6} y={y(-yMax / 1.15) + 4} textAnchor="end">{(-yMax / 1.15).toFixed(1)}°</text>
      <path className="line-earth" d={path} />
      {rows.map((row, i) => (
        <g key={row.label + i}>
          <text className="axis" x={PAD.l - 6} y={rowY(i) + 8} textAnchor="end">{row.label}</text>
          {row.windows.map((w) => {
            const a = x(Date.parse(w.start_utc));
            return <rect key={w.start_utc} className={row.cls} x={a} y={rowY(i) + 1} width={Math.max(0.5, x(Date.parse(w.end_utc)) - a)} height={ROW_H - 3} />;
          })}
        </g>
      ))}
      {ticks.map((ms) => (
        <text key={ms} className="axis" x={x(ms)} y={H - 8} textAnchor="middle">
          +{Math.round((ms - t0) / 3.6e6)} h
        </text>
      ))}
    </svg>
  );
}

function Notes({ title, items, open }: { title: string; items: string[]; open?: boolean }) {
  if (!items.length) return null;
  return (
    <details open={open}>
      <summary>{title}</summary>
      <ul>{items.map((s) => <li key={s}>{s}</li>)}</ul>
    </details>
  );
}

function Field(props: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <label>
      {props.label}
      <input type="number" value={props.value} step={props.step}
        onChange={(e) => Number.isFinite(e.target.valueAsNumber) && props.onChange(e.target.valueAsNumber)} />
    </label>
  );
}

/** Direct-to-Earth radio-link windows for the current scenario (engineering estimate). */
export function RadioLinkPanel({ scenario }: { scenario: ScenarioRequest }) {
  const [settings, setSettings] = useState<RadioSettings>(DEFAULT_RADIO_SETTINGS);
  const [result, setResult] = useState<RadioLinkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setLink = (patch: Partial<RadioSettings["link"]>) => setSettings((s) => ({ ...s, link: { ...s.link, ...patch } }));

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.radioLink(buildRadioRequest(scenario, settings)));
    } catch (e) {
      setResult(null);
      if (e instanceof ApiError && e.body) {
        const d = e.body.error.details.map((x) => `${x.field}: ${x.issue}`).join("; ");
        setError(`${e.body.error.code}: ${e.body.error.message}${d ? ` (${d})` : ""}`);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const sum = result?.summary;
  return (
    <details className="radio">
      <summary>Radio link to Earth — engineering estimate</summary>
      <p className="muted small">
        When can this site close a direct radio link with Earth? Needs Earth above the lunar horizon, a ground station
        seeing the Moon, and a link budget that closes. Uses the site, start, duration and step above. The figures below
        are illustrative starting values, not a real spacecraft — replace them.
      </p>
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <div className="grid2">
          <Field label="Carrier frequency (MHz)" value={settings.link.frequency_hz / 1e6} step={10} onChange={(v) => setLink({ frequency_hz: v * 1e6 })} />
          <Field label="Transmit EIRP (dBW)" value={settings.link.eirp_dbw} step={1} onChange={(v) => setLink({ eirp_dbw: v })} />
          <Field label="Receiver G/T (dB/K)" value={settings.link.rx_g_over_t_db_k} step={1} onChange={(v) => setLink({ rx_g_over_t_db_k: v })} />
          <Field label="Other losses (dB)" value={settings.link.other_losses_db} step={0.5} onChange={(v) => setLink({ other_losses_db: v })} />
          <Field label="Data rate (kbit/s)" value={settings.link.data_rate_bps / 1e3} step={10} onChange={(v) => setLink({ data_rate_bps: v * 1e3 })} />
          <Field label="Required Eb/N0 (dB)" value={settings.link.required_ebn0_db} step={0.5} onChange={(v) => setLink({ required_ebn0_db: v })} />
          <Field label="Lunar antenna mask (° above horizon)" value={settings.minEarthElevationDeg} step={0.5}
            onChange={(v) => setSettings((s) => ({ ...s, minEarthElevationDeg: v }))} />
          <Field label="Ground station mask (°)" value={settings.stationMaskDeg} step={1}
            onChange={(v) => setSettings((s) => ({ ...s, stationMaskDeg: v }))} />
        </div>
        <fieldset className="stations">
          <legend>Ground stations (approximate locations)</legend>
          {STATION_PRESETS.map((s, i) => (
            <label key={s.name} className="check">
              <input
                type="checkbox"
                checked={settings.stations.includes(i)}
                onChange={(e) =>
                  setSettings((st) => ({
                    ...st,
                    stations: e.target.checked ? [...st.stations, i].sort() : st.stations.filter((k) => k !== i),
                  }))
                }
              />
              {s.name}
            </label>
          ))}
        </fieldset>
        <div className="actions">
          <button type="button" disabled={busy || settings.stations.length === 0} onClick={run}>
            {busy ? "Computing…" : "Compute radio windows"}
          </button>
        </div>
      </form>
      {error && <div className="error" role="alert">{error}</div>}
      {result && sum && (
        <section className="result">
          <header className="result-head">
            <span className="status status-engineering">engineering estimate</span>
            <span>{result.message}</span>
          </header>
          <dl className="kv radio-kv">
            <dt>Link available</dt>
            <dd>{formatPercent(sum.link_available_fraction)} of {formatDuration(sum.span_hours)}</dd>
            <dt>Longest outage</dt>
            <dd>{formatDuration(sum.longest_link_outage_hours)}</dd>
            <dt>Earth above lunar mask</dt>
            <dd>{formatPercent(sum.earth_visible_fraction)}</dd>
            <dt>A station sees the Moon</dt>
            <dd>{formatPercent(sum.ground_station_visible_fraction)}</dd>
            <dt>Link margin</dt>
            <dd>{sum.link_margin_db_min.toFixed(1)} … {sum.link_margin_db_max.toFixed(1)} dB</dd>
            <dt>Max |Doppler|</dt>
            <dd>{(sum.max_abs_doppler_hz / 1e3).toFixed(2)} kHz</dd>
          </dl>
          <Notes title="Warnings" items={result.warnings} open />
          {result.samples.length > 1 && (
            <>
              <div className="legend">
                <span className="sw earth" /> Earth centre elevation at the site
                <span className="muted"> · rows = each condition met; LINK = all three (model estimate, not a guaranteed link)</span>
              </div>
              <RadioTimeline result={result} />
              <h4>Link windows (UTC)</h4>
              {result.windows.link_available.length === 0 ? (
                <p className="muted">none in sampled range</p>
              ) : (
                <ul className="windows radio-windows">
                  {result.windows.link_available.map((w) => (
                    <li key={w.start_utc}>
                      {w.clipped_start ? "≤ " : ""}
                      {w.start_utc.slice(0, 16)}Z → {w.end_utc.slice(0, 16)}Z{w.clipped_end ? " ≥" : ""}
                      <span className="muted"> ({formatDuration((Date.parse(w.end_utc) - Date.parse(w.start_utc)) / 3.6e6)})</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <dl className="model">
            <dt>Ephemeris</dt>
            <dd>{result.model.ephemeris_provider} (analytic, low precision — not SPICE)</dd>
            <dt>Horizon model</dt>
            <dd>Ideal geometric horizon (no terrain)</dd>
            <dt>Body-fixed frame</dt>
            <dd>{result.model.body_fixed_frame}</dd>
            <dt>Time scale</dt>
            <dd>{result.model.time_scale_note}</dd>
          </dl>
          <Notes title="Assumptions" items={result.assumptions} />
          <Notes title="Data provenance" items={result.data_provenance.map((p) => `${p.name} [${p.kind}] — ${p.source}. ${p.notes}`)} />
        </section>
      )}
    </details>
  );
}
