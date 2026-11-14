import { useEffect, useState } from "react";

import { getCelestialState } from "../../api/celestial";
import type { CelestialStateResponse } from "../../api/celestialTypes";
import { AU_M, EARTH_MEAN_RADIUS_M } from "../../lib/constants";
import { BODY_ENLARGEMENT, CelestialScene, type SceneView } from "./CelestialScene";
import { MoonPhaseIcon } from "./MoonPhaseIcon";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SLIDER_HALF_SPAN_DAYS = 15;
const SPEEDS = [
  { label: "1 h / s", hoursPerSecond: 1 },
  { label: "6 h / s", hoursPerSecond: 6 },
  { label: "1 day / s", hoursPerSecond: 24 },
];

const nowMinute = () => new Date(Math.floor(Date.now() / 60_000) * 60_000);

/** `<input type="datetime-local">` has no timezone: we always read/write it as UTC. */
const toInputUtc = (d: Date) => d.toISOString().slice(0, 16);
const fromInputUtc = (s: string) => new Date(`${s}:00Z`);

const fmtDeg = (x: number, digits = 1) => `${x.toFixed(digits)}°`;
const fmtSignedDeg = (x: number, digits = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(digits)}°`;
const fmtKm = (m: number, roundToKm = 1) =>
  `${(Math.round(m / 1000 / roundToKm) * roundToKm).toLocaleString("en-US").replace(/,/g, " ")} km`;
function fmtRa(deg: number): string {
  const totalMin = Math.round((deg / 15) * 60) % (24 * 60);
  return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, "0")}m`;
}

function Row({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <>
      <dt title={hint}>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

/** `active` is false while the tab is hidden: rendering and playback pause. */
export function CelestialDashboard({ active }: { active: boolean }) {
  const [date, setDate] = useState(nowMinute);
  const [anchor, setAnchor] = useState(date);
  const [view, setView] = useState<SceneView>("earth-moon");
  const [enlargeBodies, setEnlargeBodies] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(SPEEDS[1].hoursPerSecond);
  const [state, setState] = useState<CelestialStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false); // opened from the "⋯" button

  useEffect(() => {
    let current = true;
    getCelestialState(date)
      .then((s) => current && (setState(s), setError(null)))
      .catch((e) => current && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      current = false;
    };
  }, [date]);

  useEffect(() => {
    if (!playing || !active) return;
    const tickMs = 50;
    const id = setInterval(() => setDate((d) => new Date(d.getTime() + speed * HOUR_MS * (tickMs / 1000))), tickMs);
    return () => clearInterval(id);
  }, [playing, speed, active]);

  // Keep the scrub slider usable: re-centre it when the date leaves its range.
  useEffect(() => {
    if (Math.abs(date.getTime() - anchor.getTime()) > SLIDER_HALF_SPAN_DAYS * DAY_MS) setAnchor(date);
  }, [date, anchor]);

  const jump = (ms: number) => setDate((d) => new Date(d.getTime() + ms));
  const setAbsolute = (d: Date) => {
    if (Number.isNaN(d.getTime())) return;
    setDate(d);
    setAnchor(d);
  };
  const offsetHours = (date.getTime() - anchor.getTime()) / HOUR_MS;

  return (
    <div className={`dash${panelOpen ? "" : " panel-collapsed"}`}>
      {state ? (
        <CelestialScene state={state} view={view} enlargeBodies={enlargeBodies} active={active} />
      ) : (
        <div className="celestial-canvas placeholder">Loading…</div>
      )}

      {/* Top-left overlay: phase summary, view, time controls (same place as the scenario compass). */}
      <div className="dash-overlay">
        {state && (
          <div className="phase-row">
            <MoonPhaseIcon fraction={state.derived.illuminated_fraction} waxing={state.derived.waxing} />
            <div>
              <div className="big">{state.derived.phase_name}</div>
              <div className="muted">
                {(state.derived.illuminated_fraction * 100).toFixed(0)} % illuminated · {state.derived.waxing ? "waxing" : "waning"}
              </div>
            </div>
          </div>
        )}

        <div className="view-toggle" role="tablist" aria-label="3D view">
          <button role="tab" aria-selected={view === "earth-moon"} className={view === "earth-moon" ? "active" : ""} onClick={() => setView("earth-moon")}>
            Earth–Moon (to scale)
          </button>
          <button role="tab" aria-selected={view === "solar"} className={view === "solar" ? "active" : ""} onClick={() => setView("solar")}>
            Sun–Earth–Moon (schematic)
          </button>
        </div>
        {view === "earth-moon" && (
          <label className="check">
            <input type="checkbox" checked={enlargeBodies} onChange={(e) => setEnlargeBodies(e.target.checked)} />
            Enlarge Earth &amp; Moon ×{BODY_ENLARGEMENT}
          </label>
        )}

        <input
          className="date-input"
          type="datetime-local"
          step={60}
          value={toInputUtc(date)}
          onChange={(e) => setAbsolute(fromInputUtc(e.target.value))}
          aria-label="Date and time, UTC"
        />
        <div className="step-buttons">
          <button onClick={() => jump(-DAY_MS)}>−1 d</button>
          <button onClick={() => jump(-HOUR_MS)}>−1 h</button>
          <button onClick={() => setAbsolute(nowMinute())}>Now</button>
          <button onClick={() => jump(HOUR_MS)}>+1 h</button>
          <button onClick={() => jump(DAY_MS)}>+1 d</button>
        </div>
        <label className="scrub">
          <span>
            ±{SLIDER_HALF_SPAN_DAYS} d around {toInputUtc(anchor).replace("T", " ")} UTC{" "}
            <b>{offsetHours >= 0 ? "+" : "−"}{(Math.abs(offsetHours) / 24).toFixed(1)} d</b>
          </span>
          <input
            type="range"
            min={-SLIDER_HALF_SPAN_DAYS * 24}
            max={SLIDER_HALF_SPAN_DAYS * 24}
            step={1}
            value={Math.round(offsetHours)}
            onChange={(e) => setDate(new Date(anchor.getTime() + Number(e.target.value) * HOUR_MS))}
            aria-label="Scrub date"
          />
        </label>
        <div className="play-row">
          <button onClick={() => setPlaying((p) => !p)} className={playing ? "active" : ""} aria-label={playing ? "Pause" : "Play"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <option key={s.hoursPerSecond} value={s.hoursPerSecond}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        {state?.synthetic && (
          <div className="sky-note">SYNTHETIC MOCK — low-precision formulae in the browser, not SPICE. Not for analysis.</div>
        )}
        {error && <div className="error" role="alert">{error}</div>}
      </div>

      <button
        className="dash-panel-toggle"
        type="button"
        aria-expanded={panelOpen}
        title="Details"
        aria-label="Details"
        onClick={() => setPanelOpen((o) => !o)}
      >
        ⋯
      </button>

      {/* "⋯" panel: the detailed numbers, frame and assumptions. */}
      <aside className="dash-panel">
        {state && (
          <>
            <section>
              <h2>
                <span className="dot moon" /> Moon relative to Earth
              </h2>
              <dl className="kv">
                <Row k="Distance (centre–centre)" v={`${fmtKm(state.moon_from_earth.distance_m, 100)} · ${(state.moon_from_earth.distance_m / EARTH_MEAN_RADIUS_M).toFixed(1)} R⊕`} hint="Rounded to 100 km: the mock's stated accuracy is ~0.3 %." />
                <Row k="Ecliptic longitude λ" v={fmtDeg(state.moon_from_earth.longitude_deg)} />
                <Row k="Ecliptic latitude β" v={fmtSignedDeg(state.moon_from_earth.latitude_deg)} />
                <Row k="Right ascension α" v={fmtRa(state.moon_from_earth.right_ascension_deg)} />
                <Row k="Declination δ" v={fmtSignedDeg(state.moon_from_earth.declination_deg)} />
                <Row k="Elongation (Sun–Earth–Moon)" v={fmtDeg(state.derived.elongation_deg)} />
              </dl>
            </section>

            <section>
              <h2>
                <span className="dot sun" /> Moon relative to Sun
              </h2>
              <dl className="kv">
                <Row k="Distance Sun–Moon" v={`${(state.moon_from_sun.distance_m / AU_M).toFixed(4)} AU`} />
                <Row k="" v={fmtKm(state.moon_from_sun.distance_m, 1000)} />
                <Row k="Heliocentric λ" v={fmtDeg(state.moon_from_sun.longitude_deg)} />
                <Row k="Heliocentric β" v={fmtSignedDeg(state.moon_from_sun.latitude_deg, 2)} />
                <Row k="Phase angle (Sun–Moon–Earth)" v={fmtDeg(state.derived.phase_angle_deg)} />
                <Row k="Sun–Earth distance" v={`${(state.sun_from_earth.distance_m / AU_M).toFixed(4)} AU`} />
                <Row k="Sun ecliptic λ (from Earth)" v={fmtDeg(state.sun_from_earth.longitude_deg, 2)} />
              </dl>
            </section>

            <section className="small">
              <h2>Frame, model &amp; assumptions</h2>
              <dl className="kv small">
                <Row k="Status" v={state.status} />
                <Row k="Provider" v={state.model.provider} />
                <Row k="Frame" v={state.frame.name} />
                <Row k="Time" v={state.model.time_scale_note} />
                <Row k="Accuracy" v={state.model.nominal_accuracy} />
              </dl>
              <p className="muted small">{state.frame.description}</p>
              <ul className="small">
                {state.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
              {state.warnings.length > 0 && (
                <ul className="small warn-text">
                  {state.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </aside>
    </div>
  );
}
