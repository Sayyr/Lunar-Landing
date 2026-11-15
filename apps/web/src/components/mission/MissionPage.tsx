// "Mission" page: set up a surface-stay mission on the current scenario (site, landing date, stay),
// play it, inject a delay while approaching, read the verdict and the computed corrections, apply one,
// and compare saved runs. All numbers come from the science service (POST /scenarios/simulate).
import { useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError } from "../../api/client";
import type { Correction, MissionConstraints, MissionRequest, MissionResponse, PowerParams } from "../../api/missionTypes";
import type { ScenarioRequest } from "../../api/types";
import { applyCorrection, bestIndex, buildMissionRequest, comparisonRows, draftPower, EXAMPLE_CONSTRAINTS, EXAMPLE_POWER, hoursBetween, type MissionDraft, type MissionSettings, type SavedMission, uniqueName, toFormUtc } from "../../lib/mission";
import { DEFAULT_RADIO_SETTINGS, formatDuration } from "../../lib/radio";
import { formatLat, formatLon } from "../../lunar/geo";
import { MISSION_PRESETS, type MissionPreset } from "../../lib/missionPresets";
import { DateScanStrip } from "./DateScanStrip";
import { MissionCalculations } from "./MissionCalculations";
import { MissionTimeline, type PlaybackSpan } from "./MissionTimeline";
import { MissionTrajectory } from "./MissionTrajectory";
import type { TrajectoryView } from "../../lib/trajectory";

/** Playback only: hours shown before the planned landing. No trajectory is modelled. */
const APPROACH_HOURS = 24;
const SPEEDS = [1, 6, 24, 72]; // simulated hours per second

const describe = (e: unknown) =>
  e instanceof ApiError && e.body
    ? `${e.body.error.code}: ${e.body.error.message}${e.body.error.details.length ? ` (${e.body.error.details.map((d) => `${d.field}: ${d.issue}`).join("; ")})` : ""}`
    : e instanceof Error
      ? e.message
      : String(e);
const pct = (f: number | null | undefined, d = 0) => (f == null || !Number.isFinite(f) ? "—" : `${(f * 100).toFixed(d)} %`);
const n0 = (v: number | null | undefined, unit = "") => (v == null || !Number.isFinite(v) ? "—" : `${Math.round(v).toLocaleString("en-US")}${unit}`);
const utc = (s: string | null | undefined) => (s ? s.slice(0, 16).replace("T", " ") + " UTC" : "—");

const CORRECTION_LABEL: Record<Correction["kind"], string> = {
  abort: "Abort",
  retime_landing: "Land later",
  change_date: "Change the date",
  move_site: "Move the site",
  relax_slope: "Relax the slope limit",
  shorten_stay: "Shorten the stay",
  resize_battery: "Bigger battery",
  resize_panels: "Bigger solar array",
};


function Num({ label, value, onChange, step = 1, min, max, suffix }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string }) {
  return (
    <label>
      {label}
      <span className="mission-input">
        <input type="number" value={Number.isFinite(value) ? value : ""} step={step} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} />
        {suffix && <span className="muted small">{suffix}</span>}
      </span>
    </label>
  );
}

/** A nullable constraint: checkbox to apply it + value. */
function Limit({ label, value, fallback, onChange, step = 1, suffix, scale = 1 }: { label: string; value: number | null; fallback: number; onChange: (v: number | null) => void; step?: number; suffix?: string; scale?: number }) {
  return (
    <label className="mission-limit">
      <input type="checkbox" checked={value !== null} onChange={(e) => onChange(e.target.checked ? fallback : null)} />
      <span>{label}</span>
      <input type="number" disabled={value === null} step={step} value={value === null ? "" : +(value * scale).toFixed(6)} onChange={(e) => onChange(Number(e.target.value) / scale)} />
      {suffix && <span className="muted small">{suffix}</span>}
    </label>
  );
}

interface MissionPageProps {
  active: boolean;
  scenario: ScenarioRequest;
  onScenario: (s: ScenarioRequest) => void;
  draft: MissionDraft | null;
  /** named, simulated missions (kept by App: the Sun · Earth · Moon page picks them by name) */
  saved: SavedMission[];
  onSaved: (update: (all: SavedMission[]) => SavedMission[]) => void;
  /** Earth→Moon trajectory shared with the Sun · Earth · Moon page */
  trajectory: TrajectoryView | null;
  onTrajectory: (v: TrajectoryView) => void;
  onShowTrajectory: (focusUtc: string) => void;
}

export function MissionPage({ active, scenario, onScenario, draft, saved, onSaved: setSaved, trajectory, onTrajectory, onShowTrajectory }: MissionPageProps) {
  const [power, setPower] = useState<PowerParams>(EXAMPLE_POWER);
  // Energy (solar + battery) is optional and the lowest priority: off by default.
  const [usePower, setUsePower] = useState(false);
  const [constraints, setConstraints] = useState<MissionConstraints>(EXAMPLE_CONSTRAINTS);
  const [useRadio, setUseRadio] = useState(false);
  const [radio, setRadio] = useState(DEFAULT_RADIO_SETTINGS);
  const [preLoad, setPreLoad] = useState<number | null>(80);
  const [endPolicy, setEndPolicy] = useState<MissionSettings["endPolicy"]>("fixed_duration");
  const [synthetic, setSynthetic] = useState(false);
  const [showCalc, setShowCalc] = useState(false);
  const [massKg, setMassKg] = useState<number | null>(null);

  const [result, setResult] = useState<MissionResponse | null>(null);
  const [lastReq, setLastReq] = useState<MissionRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aborted, setAborted] = useState<string | null>(null);

  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(6);
  const [delayStep, setDelayStep] = useState(24);

  const [compare, setCompare] = useState<number[]>([]);
  const nextId = useRef(1);
  // Name of the mission on screen (from "Create mission" or "Save"); it follows delays and corrections.
  const [missionName, setMissionName] = useState<string | null>(null);
  const [saveName, setSaveName] = useState("");

  const [preset, setPreset] = useState<MissionPreset | null>(null);
  const loadPreset = (id: string) => {
    const p = MISSION_PRESETS.find((x) => x.id === id) ?? null;
    setPreset(p);
    if (!p) return;
    onScenario(p.scenario);
    setPower(p.powerValues ?? p.settings.power ?? EXAMPLE_POWER);
    setUsePower(p.settings.power !== null);
    setConstraints(p.settings.constraints);
    setUseRadio(p.settings.radio !== null);
    if (p.settings.radio) setRadio(p.settings.radio);
    setPreLoad(p.settings.preLandingLoadW);
    setEndPolicy(p.settings.endPolicy);
    setSynthetic(false);
    setMissionName(null);
    setResult(null);
    setPlaying(false);
    setMassKg(null);
  };

  const settings: MissionSettings = { power: usePower ? power : null, constraints, radio: useRadio ? radio : null, preLandingLoadW: preLoad, endPolicy };

  const run = async (req: MissionRequest, opts: { keepCursor?: boolean; saveBefore?: string } = {}) => {
    setBusy(true);
    setError(null);
    setAborted(null);
    try {
      const r = await (synthetic ? api.missionSimulateSynthetic(req) : api.missionSimulate(req));
      if (opts.saveBefore && result) save(result, missionName ? `${missionName} — ${opts.saveBefore.toLowerCase()}` : opts.saveBefore, false);
      setResult(r);
      setLastReq(req);
      if (!opts.keepCursor) setCursor(Date.parse(r.pre_landing.planned_landing_utc) - APPROACH_HOURS * 3_600_000);
      return r;
    } catch (e) {
      setError(describe(e));
      setPlaying(false);
      return null;
    } finally {
      setBusy(false);
    }
  };

  /** Saves under a distinct name; `current` = this is now the mission on screen. */
  const save = (r: MissionResponse, name: string, current = true) => {
    const id = Math.max(nextId.current, ...saved.map((x) => x.id + 1));
    nextId.current = id + 1;
    const unique = uniqueName(name, saved.map((x) => x.name));
    setSaved((s) => [...s, { id, name: unique, result: r }]);
    setCompare((c) => (c.length < 4 ? [...c, id] : c));
    if (current) setMissionName(unique);
  };

  const play = async () => {
    setMissionName(null);
    const r = await run(buildMissionRequest(scenario, settings, 0));
    if (r) setPlaying(true);
  };

  // "Create mission" on the Site scenario page: take its values and simulate once per click (seq).
  const draftSeq = useRef(0);
  useEffect(() => {
    if (!draft || draft.seq === draftSeq.current) return;
    draftSeq.current = draft.seq;
    const p = draftPower(draft, power);
    if (p) setPower(p);
    setUsePower(p !== null);
    setPreset(null);
    setMassKg(draft.vehicleMassKg);
    setPlaying(false);
    // settings above reach state only on the next render: build this request from the draft's values.
    void run(buildMissionRequest(scenario, { ...settings, power: p }, 0)).then((r) => {
      if (!r) return;
      save(r, draft.name);
      setPlaying(true);
    });
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  // Playback span and clock.
  const span: PlaybackSpan | null = useMemo(() => {
    if (!result) return null;
    const start = Date.parse(result.pre_landing.planned_landing_utc) - APPROACH_HOURS * 3_600_000;
    const end = result.inventory ? Date.parse(result.inventory.end_utc) : Date.parse(result.pre_landing.landing_utc);
    return { start, end: Math.max(end, start + 3_600_000) };
  }, [result]);

  useEffect(() => {
    if (!playing || !span || !active) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setCursor((c) => {
        const next = Math.min(span.end, c + dt * speed * 3_600_000);
        if (next >= span.end) setPlaying(false);
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, span, speed, active]);

  const landingMs = result ? Date.parse(result.pre_landing.landing_utc) : 0;
  const beforeLanding = !!result && cursor < landingMs;
  const sample = useMemo(() => {
    if (!result || !result.timeline.length || cursor < landingMs) return null;
    let best = result.timeline[0];
    for (const s of result.timeline) if (Date.parse(s.utc) <= cursor) best = s;
    return best;
  }, [result, cursor, landingMs]);

  const injectDelay = async () => {
    if (!lastReq || !result) return;
    const d = (lastReq.delay?.landing_delay_hours ?? 0) + delayStep;
    const req: MissionRequest = { ...lastReq, delay: { ...(lastReq.delay ?? { end_policy: endPolicy, pre_landing_net_load_w: preLoad }), landing_delay_hours: d } };
    setPlaying(false);
    const r = await run(req, { keepCursor: true, saveBefore: `Before +${delayStep} h delay` });
    if (r) {
      save(r, `After delay (${d} h total)`);
      setPlaying(true);
    }
  };

  const applyFix = async (c: Correction) => {
    if (!lastReq) return;
    if (c.kind === "abort") {
      setPlaying(false);
      setAborted(c.summary);
      return;
    }
    const req = applyCorrection(lastReq, c);
    if (!req) return;
    // Keep the form in line with what was applied.
    if ((c.kind === "resize_battery" || c.kind === "resize_panels") && req.power) setPower(req.power);
    if (c.kind === "change_date" && c.landing_utc) onScenario({ ...scenario, start_utc: toFormUtc(c.landing_utc) });
    if (c.kind === "move_site" && c.site)
      onScenario({ ...scenario, site: { ...scenario.site, ...c.site }, ...(c.landing_utc ? { start_utc: toFormUtc(c.landing_utc) } : {}) });
    if (c.kind === "relax_slope" && c.landing_utc) onScenario({ ...scenario, start_utc: toFormUtc(c.landing_utc) });
    if (c.kind === "relax_slope" && c.max_slope_deg != null) setConstraints({ ...constraints, max_slope_deg: c.max_slope_deg });
    if (c.kind === "shorten_stay") {
      onScenario({ ...scenario, duration_hours: req.surface_hours });
      setEndPolicy("fixed_duration");
    }
    const r = await run(req, { keepCursor: true });
    if (r) save(r, `${CORRECTION_LABEL[c.kind]}`);
  };

  const shown = saved.filter((s) => compare.includes(s.id));
  const rows = useMemo(() => comparisonRows(shown.map((s) => s.result)), [shown]);
  const inv = result?.inventory;

  return (
    <div className="mission-page">
      <header>
        <h2>Mission simulation{missionName && <> — “{missionName}”</>}</h2>
        <p className="muted">
          Site {formatLat(scenario.site.latitude_deg, 3)}, {formatLon(scenario.site.longitude_deg, scenario.site.latitude_deg, 3)} (from the Site scenario tab) ·{" "}
          {scenario.terrain_mode === "dem" ? "DEM terrain horizon" : "ideal horizon"}. Engineering screening: every vehicle figure below is yours to set — the
          defaults are illustrative, not a real lander.
        </p>
        {massKg !== null && (
          <p className="small">
            Vehicle mass {massKg.toLocaleString("en-US")} kg <span className="muted">— recorded only: no model below uses it (no propulsion or descent model).</span>
          </p>
        )}
      </header>

      <div className="mission-layout">
        <section className="mission-setup">
          <fieldset>
            <legend>Preset from a real mission</legend>
            <select value={preset?.id ?? ""} onChange={(e) => loadPreset(e.target.value)}>
              <option value="">— your own mission —</option>
              {MISSION_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {preset && (
              <div className="mission-preset small">
                <p>{preset.summary}</p>
                <p className="muted">Published facts used:</p>
                <ul>
                  {preset.facts.map((f) => (
                    <li key={f.label}>
                      <strong>{f.label}:</strong> {f.value} —{" "}
                      <a href={f.url} target="_blank" rel="noopener noreferrer">{f.source}</a>
                    </li>
                  ))}
                </ul>
                <p className="warn">Assumed (not published):</p>
                <ul>
                  {preset.assumed.map((a) => <li key={a}>{a}</li>)}
                </ul>
                <p><strong>Check:</strong> {preset.check}</p>
              </div>
            )}
          </fieldset>
          <fieldset>
            <legend>Landing &amp; stay</legend>
            <label>
              Planned landing (UTC)
              <input type="datetime-local" step={60} value={scenario.start_utc.slice(0, 16)} onChange={(e) => e.target.value && onScenario({ ...scenario, start_utc: `${e.target.value}:00Z` })} />
            </label>
            <div className="grid2">
              <Num label="Surface stay" suffix="h" value={scenario.duration_hours} min={1} onChange={(v) => onScenario({ ...scenario, duration_hours: v })} />
              <Num label="Step" suffix="min" value={scenario.step_minutes} min={1} onChange={(v) => onScenario({ ...scenario, step_minutes: v })} />
            </div>
            <label>
              Horizon
              <select value={scenario.terrain_mode} onChange={(e) => onScenario({ ...scenario, terrain_mode: e.target.value as ScenarioRequest["terrain_mode"] })}>
                <option value="dem">DEM terrain horizon (LOLA)</option>
                <option value="ideal">Ideal geometric horizon</option>
              </select>
            </label>
            <label>
              If the landing is delayed
              <select value={endPolicy} onChange={(e) => setEndPolicy(e.target.value as MissionSettings["endPolicy"])}>
                <option value="fixed_duration">keep the stay length (end moves later)</option>
                <option value="fixed_end">keep the end date (stay gets shorter)</option>
              </select>
            </label>
            {usePower && <Limit label="Battery draw while waiting" value={preLoad} fallback={80} suffix="W net" onChange={setPreLoad} />}
          </fieldset>

          <fieldset>
            <legend>Power (optional)</legend>
            <label className="mission-limit">
              <input type="checkbox" checked={usePower} onChange={(e) => setUsePower(e.target.checked)} />
              <span>Model energy: solar array + battery</span>
            </label>
            {!usePower && <p className="muted small">Off: no battery or array figures needed; Sun hours are still computed.</p>}
            {usePower && (<>
            <div className="grid2">
              <Num label="Array area" suffix="m²" step={0.1} min={0} value={power.panel_area_m2} onChange={(v) => setPower({ ...power, panel_area_m2: v })} />
              <Num label="Array efficiency" suffix="%" step={1} min={1} max={100} value={+(power.panel_efficiency * 100).toFixed(4)} onChange={(v) => setPower({ ...power, panel_efficiency: v / 100 })} />
              <Num label="Load" suffix="W" step={10} min={0} value={power.load_w} onChange={(v) => setPower({ ...power, load_w: v })} />
              <Num label="Battery" suffix="Wh" step={100} min={1} value={power.battery_capacity_wh} onChange={(v) => setPower({ ...power, battery_capacity_wh: v })} />
              <Num label="Initial charge" suffix="%" step={1} min={0} max={100} value={+(power.battery_initial_soc * 100).toFixed(4)} onChange={(v) => setPower({ ...power, battery_initial_soc: v / 100 })} />
              <Num label="Charge / disch. eff." suffix="%" step={1} min={1} max={100} value={+(power.charge_efficiency * 100).toFixed(4)} onChange={(v) => setPower({ ...power, charge_efficiency: v / 100, discharge_efficiency: v / 100 })} />
            </div>
            <label>
              Panel pointing
              <select value={power.panel_pointing} onChange={(e) => setPower({ ...power, panel_pointing: e.target.value as PowerParams["panel_pointing"] })}>
                <option value="vertical">Vertical, turned to the Sun (polar landers)</option>
                <option value="sun_tracking">Full Sun tracking</option>
                <option value="horizontal">Flat (horizontal)</option>
              </select>
            </label>
            </>)}
          </fieldset>

          <fieldset>
            <legend>Communications</legend>
            <label className="mission-limit">
              <input type="checkbox" checked={useRadio} onChange={(e) => setUseRadio(e.target.checked)} />
              <span>Direct-to-Earth radio link (3 DSN complexes, approx.)</span>
            </label>
            {useRadio ? (
              <div className="grid2">
                <Num label="Data rate" suffix="kbit/s" step={10} min={0.001} value={radio.link.data_rate_bps / 1000} onChange={(v) => setRadio({ ...radio, link: { ...radio.link, data_rate_bps: v * 1000 } })} />
                <Num label="EIRP" suffix="dBW" step={1} value={radio.link.eirp_dbw} onChange={(v) => setRadio({ ...radio, link: { ...radio.link, eirp_dbw: v } })} />
                <Num label="Ground G/T" suffix="dB/K" step={1} value={radio.link.rx_g_over_t_db_k} onChange={(v) => setRadio({ ...radio, link: { ...radio.link, rx_g_over_t_db_k: v } })} />
                <Num label="Required Eb/N0" suffix="dB" step={0.5} value={radio.link.required_ebn0_db} onChange={(v) => setRadio({ ...radio, link: { ...radio.link, required_ebn0_db: v } })} />
              </div>
            ) : (
              <p className="muted small">Off: contact = geometric Earth visibility (not a radio link), no data volume.</p>
            )}
          </fieldset>

          <fieldset>
            <legend>Go / no-go constraints</legend>
            {usePower && <Limit label="Battery reserve ≥" value={constraints.min_battery_soc} fallback={0.2} scale={100} suffix="%" onChange={(v) => setConstraints({ ...constraints, min_battery_soc: v })} />}
            <Limit label="Longest contact gap ≤" value={constraints.max_earth_outage_hours} fallback={48} suffix="h" onChange={(v) => setConstraints({ ...constraints, max_earth_outage_hours: v })} />
            <Limit label="Contact time ≥" value={constraints.min_contact_hours} fallback={24} suffix="h" onChange={(v) => setConstraints({ ...constraints, min_contact_hours: v })} />
            <Limit label="Data to Earth ≥" value={constraints.min_data_volume_mbit} fallback={1000} step={100} suffix="Mbit" onChange={(v) => setConstraints({ ...constraints, min_data_volume_mbit: v })} />
            <Limit label="Landing slope ≤" value={constraints.max_slope_deg} fallback={10} step={0.5} suffix="°" onChange={(v) => setConstraints({ ...constraints, max_slope_deg: v, min_slope_ok_fraction: v === null ? null : constraints.min_slope_ok_fraction ?? 0.95 })} />
            {constraints.max_slope_deg !== null && (
              <Limit label="…on at least" value={constraints.min_slope_ok_fraction} fallback={0.95} scale={100} suffix="% of the 4 km disc" onChange={(v) => setConstraints({ ...constraints, min_slope_ok_fraction: v })} />
            )}
          </fieldset>

          <div className="actions">
            <button type="button" className="primary" disabled={busy} onClick={play}>
              {busy ? "Simulating…" : "▶ Play scenario"}
            </button>
            <label className="mission-limit">
              <input type="checkbox" checked={synthetic} onChange={(e) => setSynthetic(e.target.checked)} />
              <span className="small">Synthetic ephemerides (UI demo only)</span>
            </label>
          </div>
          {error && <div className="error" role="alert">{error}</div>}
        </section>

        <section className="mission-run">
          {!result && <p className="muted">Set the mission up, then ▶ Play. The simulation runs on the science service; playback replays its result.</p>}
          {result && span && (
            <>
              <div className={`mission-verdict verdict-${aborted ? "abort" : result.verdict}`}>
                <strong>{aborted ? "ABORTED" : result.verdict === "go" ? "GO" : result.verdict === "no_go" ? "NO GO" : "INCOMPLETE"}</strong>
                <span>{aborted ?? result.message}</span>
              </div>
              {result.verdict === "incomplete" && !aborted && (
                <div className="warn small">
                  Incomplete: no constraint fails, but some could not be evaluated —{" "}
                  {result.constraints.filter((c) => c.status === "not_evaluated").map((c) => `${c.label} (${c.note})`).join("; ") || "see the constraints below"}.
                  Turn those limits off or move the site to get a GO / NO GO.
                </div>
              )}
              {result.status === "not_ready" && <div className="warn small">Not computed: {result.message}</div>}
              {result.verdict === "no_go" && !aborted && (() => {
                const failing = result.constraints.filter((c) => c.status === "fail");
                // options that make the whole mission GO first, partial fixes (e.g. date only) after
                const tries = result.corrections
                  .filter((c) => c.kind !== "abort" && c.feasible)
                  .sort((a, b) => Number(b.verdict === "go") - Number(a.verdict === "go"));
                return (
                  <div className="mission-try">
                    <p>
                      <strong>Not possible as planned</strong> ({utc(result.pre_landing.landing_utc)}, {formatLat(scenario.site.latitude_deg, 2)}): {failing.map((c) => c.label).join(" · ")}.
                    </p>
                    {tries.length ? (
                      <>
                        <p className="muted small">Try instead — each option was re-simulated by the science service:</p>
                        <ul>
                          {tries.map((c, i) => (
                            <li key={i}>
                              <button type="button" className="primary" disabled={busy} onClick={() => applyFix(c)}>{CORRECTION_LABEL[c.kind]}</button>
                              <span>
                                {c.summary} <em className={c.verdict === "go" ? "slope-ok" : "warn"}>→ {c.verdict === "go" ? "GO" : "partial fix: still NO GO on its own"}</em>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p className="small">No change found within the search limits (±{((result.date_scan?.range_hours ?? 360) / 24).toFixed(0)} days, 10 km) — abort, or change the constraints.</p>
                    )}
                  </div>
                );
              })()}

              <MissionTimeline result={result} span={span} cursor={cursor} />
              <div className="mission-controls">
                <button type="button" onClick={() => (cursor >= span.end ? (setCursor(span.start), setPlaying(true)) : setPlaying(!playing))}>
                  {playing ? "❚❚ Pause" : cursor >= span.end ? "↺ Replay" : "▶ Play"}
                </button>
                <label>
                  Speed
                  <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                    {SPEEDS.map((s) => (
                      <option key={s} value={s}>{s} h/s</option>
                    ))}
                  </select>
                </label>
                <input type="range" min={span.start} max={span.end} step={60_000} value={cursor} onChange={(e) => setCursor(Number(e.target.value))} aria-label="Playback time" />
                <span className="small">{utc(new Date(cursor).toISOString())}</span>
              </div>

              <div className="mission-phase small">
                {beforeLanding ? (
                  <>
                    <strong>Approach</strong> — landing in {formatDuration((landingMs - cursor) / 3_600_000)} (playback phase; no trajectory is modelled).{" "}
                    <span className="mission-inject">
                      Delay landing by
                      <input type="number" min={1} max={720} step={1} value={delayStep} onChange={(e) => setDelayStep(Number(e.target.value))} /> h
                      <button type="button" disabled={busy || aborted !== null} onClick={injectDelay}>
                        Inject delay
                      </button>
                    </span>
                  </>
                ) : sample ? (
                  <>
                    <strong>On the surface</strong>
                    {sample.soc !== null && <> · battery {pct(sample.soc)} ({n0(sample.battery_wh, " Wh")}) · array {n0(sample.solar_w, " W")}</>} · Sun{" "}
                    {sample.sun_visible ? "up" : "down"} · Earth {sample.earth_visible ? "up" : "down"}
                    {sample.link_available !== null && ` · link ${sample.link_available ? "on" : "off"}`} · delays can only be injected before landing
                  </>
                ) : (
                  <>No surface time.</>
                )}
              </div>

              <h3>Constraints</h3>
              <table className="compare-table mission-constraints">
                <tbody>
                  {result.constraints.map((c) => {
                    const passed = c.first_violation_utc ? Date.parse(c.first_violation_utc) <= cursor : true;
                    return (
                      <tr key={c.id} className={`row-${c.status}`}>
                        <th scope="row">{c.label}</th>
                        <td>{c.status === "pass" ? "✓ pass" : c.status === "fail" ? "✗ fail" : "not evaluated"}</td>
                        <td>{c.value == null ? "—" : +c.value.toFixed(3)}</td>
                        <td className="muted">limit {c.limit == null ? "—" : +c.limit.toFixed(3)}</td>
                        <td className={passed && c.first_violation_utc ? "slope-bad" : "muted"}>{c.first_violation_utc ? `from ${utc(c.first_violation_utc)}` : c.note}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {result.corrections.length > 0 && (
                <>
                  <h3>Options</h3>
                  <ul className="mission-fixes">
                    {result.corrections.map((c, i) => (
                      <li key={i} className={c.feasible ? "" : "muted"}>
                        <button type="button" disabled={busy || !c.feasible || aborted !== null} onClick={() => applyFix(c)}>
                          {CORRECTION_LABEL[c.kind]}
                        </button>
                        <span>
                          {c.summary}
                          {c.verdict && c.kind !== "abort" && <em> → re-simulated: {c.verdict.replace("_", " ")}</em>}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {result.date_scan && (
                <>
                  <h3>Nearby landing dates</h3>
                  <p className="muted small">
                    The same mission re-simulated, with no delay, every {result.date_scan.step_hours} h within ±{(result.date_scan.range_hours / 24).toFixed(0)} days of the planned
                    landing. Click a date to plan the mission on it.
                    {result.date_scan.ignored_constraints.length > 0 && (
                      <strong className="warn"> Ignored here: {result.date_scan.ignored_constraints.join(", ")} — it fails on every date at this site; fix it with “Move the site” or “Relax the slope limit”.</strong>
                    )}
                  </p>
                  <DateScanStrip
                    scan={result.date_scan}
                    proposed={result.corrections.find((c) => c.kind === "change_date" && c.feasible)?.landing_utc ?? null}
                    onPick={(utc) => {
                      if (!lastReq) return;
                      onScenario({ ...scenario, start_utc: toFormUtc(utc) });
                      void run({ ...lastReq, landing_utc: utc, delay: { ...(lastReq.delay ?? { pre_landing_net_load_w: null }), landing_delay_hours: 0, end_policy: "fixed_duration" } }).then(
                        (r) => r && save(r, `Date ${utc.slice(0, 16).replace("T", " ")}`),
                      );
                    }}
                  />
                </>
              )}

              {inv && (
                <>
                  <h3>Resource inventory</h3>
                  <div className="mission-inventory">
                    <div>
                      <h4>Stay</h4>
                      <p>{utc(inv.landing_utc)} → {utc(inv.end_utc)}</p>
                      <p>{formatDuration(inv.surface_hours)}{result.pre_landing.landing_delay_hours > 0 && ` · landed ${formatDuration(result.pre_landing.landing_delay_hours)} late`}</p>
                    </div>
                    <div>
                      <h4>Sunlight{inv.energy.generated_wh !== null && " & energy"}</h4>
                      <p>Sun {formatDuration(inv.energy.sun_hours)} · longest night {formatDuration(inv.energy.longest_sun_outage_hours)}</p>
                      {inv.energy.generated_wh !== null ? (
                        <>
                          <p>Generated {n0(inv.energy.generated_wh / 1000)} kWh · load {n0((inv.energy.load_wh ?? NaN) / 1000)} kWh</p>
                          <p>Not supplied {n0(inv.energy.unserved_wh, " Wh")} · wasted (full) {n0(inv.energy.curtailed_wh, " Wh")}</p>
                          <p>SoC at landing {pct(inv.energy.soc_at_landing)} · min {pct(inv.energy.min_soc)} · end {pct(inv.energy.final_soc)}</p>
                        </>
                      ) : (
                        <p className="muted">Energy not modelled (optional).</p>
                      )}
                    </div>
                    {inv.sizing && (
                      <div>
                        <h4>Sizing to keep the reserve ({pct(inv.sizing.reserve_soc)})</h4>
                        <p>Battery needed {inv.sizing.required_battery_wh == null ? "none up to 10 GWh" : n0(inv.sizing.required_battery_wh, " Wh")} (have {n0(lastReq?.power?.battery_capacity_wh, " Wh")})</p>
                        <p>Array needed {inv.sizing.required_panel_area_m2 == null ? "none up to 1000 m²" : `${inv.sizing.required_panel_area_m2.toFixed(2)} m²`} (have {lastReq?.power?.panel_area_m2} m²)</p>
                      </div>
                    )}
                    <div>
                      <h4>Communications ({inv.comms.contact_basis === "radio_link" ? "radio link" : "geometric Earth visibility"})</h4>
                      <p>Earth visible {formatDuration(inv.comms.earth_visible_hours)} · longest gap {formatDuration(inv.comms.longest_earth_outage_hours)}</p>
                      {inv.comms.link_hours !== null && (
                        <p>Link {formatDuration(inv.comms.link_hours)} · longest gap {formatDuration(inv.comms.longest_link_outage_hours ?? NaN)} · {n0(inv.comms.data_volume_mbit, " Mbit")}</p>
                      )}
                    </div>
                    {inv.slope && (
                      <div>
                        <h4>Landing disc (4 km)</h4>
                        <p>
                          {inv.slope.status === "computed"
                            ? `${pct(inv.slope.fraction_ok, 1)} ≤ ${inv.slope.max_slope_deg}° · mean ${inv.slope.slope_mean_deg?.toFixed(1)}° · max ${inv.slope.slope_max_deg?.toFixed(1)}°`
                            : `not available (${inv.slope.status})`}
                        </p>
                      </div>
                    )}
                  </div>
                </>
              )}

              <div className="actions">
                <input
                  className="mission-name"
                  placeholder="name (required)"
                  maxLength={60}
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  aria-label="Name to save this run under"
                />
                <button
                  type="button"
                  disabled={!saveName.trim()}
                  title={saveName.trim() ? "" : "Give the run a name first"}
                  onClick={() => {
                    save(result, saveName);
                    setSaveName("");
                  }}
                >
                  Save for comparison
                </button>
                <button type="button" aria-expanded={showCalc} onClick={() => setShowCalc(!showCalc)}>
                  {showCalc ? "Hide calculations" : "Show calculations"}
                </button>
              </div>
              {showCalc && <MissionCalculations result={result} />}

              {missionName ? (
                <MissionTrajectory
                  site={{ latitude_deg: result.request.site.latitude_deg, longitude_deg: result.request.site.longitude_deg }}
                  landingUtc={result.pre_landing.landing_utc}
                  label={missionName}
                  current={trajectory}
                  onComputed={onTrajectory}
                  onShow={onShowTrajectory}
                />
              ) : (
                <p className="muted small">Save this run with a name to compute its Earth→Moon trajectory (and pick it later on Sun · Earth · Moon).</p>
              )}

              <details className="small">
                <summary>Assumptions, warnings and provenance</summary>
                <ul>
                  {result.assumptions.map((a) => <li key={a}>{a}</li>)}
                  {result.warnings.map((w) => <li key={w} className="warn">{w}</li>)}
                </ul>
                <p className="muted">
                  Ephemeris: {result.model.ephemeris_provider} · horizon: {result.model.horizon_model} · energy: {result.model.energy_model ?? "not modelled"}
                  {result.model.radio_model && ` · radio: ${result.model.radio_model}`}
                </p>
              </details>
            </>
          )}
        </section>
      </div>

      {saved.length > 0 && (
        <section className="mission-compare">
          <h3>Compare scenarios</h3>
          <div className="mission-saved">
            {saved.map((s) => (
              <label key={s.id} className="mission-limit">
                <input
                  type="checkbox"
                  checked={compare.includes(s.id)}
                  onChange={(e) => setCompare((c) => (e.target.checked ? [...c, s.id].slice(-4) : c.filter((x) => x !== s.id)))}
                />
                <input
                  className="mission-name"
                  value={s.name}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (missionName === s.name) setMissionName(v);
                    setSaved((all) => all.map((x) => (x.id === s.id ? { ...x, name: v } : x)));
                  }}
                />
                <span className={`badge verdict-badge-${s.result.verdict}`}>{s.result.verdict.replace("_", " ")}</span>
                <button type="button" className="link-btn" onClick={() => { setSaved((all) => all.filter((x) => x.id !== s.id)); setCompare((c) => c.filter((x) => x !== s.id)); }}>remove</button>
              </label>
            ))}
          </div>
          {shown.length > 0 && (
            <table className="compare-table">
              <thead>
                <tr>
                  <th />
                  {shown.map((s) => <th key={s.id}>{s.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const b = shown.length > 1 ? bestIndex(row) : -1;
                  return (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      {row.values.map((v, i) => (
                        <td key={i} className={i === b ? "best" : ""}>{v == null ? "—" : typeof v === "number" ? +v.toFixed(2) : v}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <p className="muted small">
            Delay before landing: {lastReq ? `${lastReq.delay?.landing_delay_hours ?? 0} h` : "—"}. Planned landing {lastReq ? utc(lastReq.landing_utc) : "—"}
            {result && lastReq && ` · effective ${utc(result.pre_landing.landing_utc)} (+${hoursBetween(lastReq.landing_utc, result.pre_landing.landing_utc).toFixed(1)} h)`}.
          </p>
        </section>
      )}
    </div>
  );
}
