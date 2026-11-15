import { useEffect, useRef, useState } from "react";

import { api, ApiError } from "../../api/client";
import { getCelestialState } from "../../api/celestial";
import type { SavedMission } from "../../lib/mission";
import { arrivalUtc, computeMissionTrajectory, toTrajectoryView, type TrajectoryView } from "../../lib/trajectory";
import type { CelestialStateResponse } from "../../api/celestialTypes";
import { AU_M, EARTH_MEAN_RADIUS_M } from "../../lib/constants";
import { DATA_README_URL } from "../../lib/links";
import { centreShift } from "../../lib/viewFit";
import { ScaleBar } from "../ScaleBar";
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

const OVERLAY_RIGHT_PX = 20 + 300;
const PANEL_PX = 380;

const describeError = (e: unknown) =>
  e instanceof ApiError && e.body
    ? `${e.body.error.code}: ${e.body.error.message}${e.body.error.details.length ? ` (${e.body.error.details.map((d) => `${d.field}: ${d.issue}`).join("; ")})` : ""}`
    : e instanceof Error
      ? e.message
      : String(e);

/**
 * `active` is false while the tab is hidden: rendering and playback pause. `site`: the landing site of
 * the Site scenario tab, the target of the Earth→Moon trajectory.
 */
export function CelestialDashboard({
  active,
  site,
  missions,
  trajectory: traj,
  onTrajectory: setTraj,
  focus,
}: {
  active: boolean;
  site: { latitude_deg: number; longitude_deg: number };
  /** named missions from the Mission page: pick one to compute its trajectory */
  missions: SavedMission[];
  /** shared with the Mission page ("Trajectory for this mission") */
  trajectory: TrajectoryView | null;
  onTrajectory: (v: TrajectoryView | null) => void;
  /** jump to this instant when seq changes (e.g. "View on Sun · Earth · Moon") */
  focus: { utc: string; seq: number } | null;
}) {
  const [date, setDate] = useState(nowMinute);
  const [anchor, setAnchor] = useState(date);
  const [view, setView] = useState<SceneView>("earth-moon");
  const [enlargeBodies, setEnlargeBodies] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(SPEEDS[1].hoursPerSecond);
  const [state, setState] = useState<CelestialStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false); // opened from the "⋯" button
  const [kmPerPx, setKmPerPx] = useState<number | null>(null);
  const [trajBusy, setTrajBusy] = useState(false);
  const [trajError, setTrajError] = useState<string | null>(null);
  const [transferDays, setTransferDays] = useState(4.5);

  const computeTrajectory = async () => {
    setTrajBusy(true);
    setTrajError(null);
    try {
      const r = await api.trajectorySimulate({
        site: { latitude_deg: site.latitude_deg, longitude_deg: site.longitude_deg },
        departure_utc: `${toInputUtc(date)}:00Z`,
        transfer_days: transferDays,
      });
      setTraj(r.status === "computed" ? toTrajectoryView(r) : null);
      if (r.status !== "computed") setTrajError(`${r.status}: ${r.message}`);
      else setPlaying(false);
    } catch (e) {
      setTraj(null);
      setTrajError(describeError(e));
    } finally {
      setTrajBusy(false);
    }
  };
  const [trajProgress, setTrajProgress] = useState<string | null>(null);
  const computeForMission = async (m: SavedMission) => {
    setTrajBusy(true);
    setTrajError(null);
    try {
      const res = await computeMissionTrajectory(
        api.trajectorySimulate,
        {
          name: m.name,
          site: { latitude_deg: m.result.request.site.latitude_deg, longitude_deg: m.result.request.site.longitude_deg },
          landingUtc: m.result.pre_landing.landing_utc,
          transferDays,
        },
        setTrajProgress,
      );
      setTraj(res.view);
      const arrival = arrivalUtc(res.view.response);
      if (arrival) setAbsolute(new Date(arrival));
      setPlaying(false);
    } catch (e) {
      setTrajError(describeError(e));
    } finally {
      setTrajBusy(false);
      setTrajProgress(null);
    }
  };
  const trajEnd = traj ? traj.points[traj.points.length - 1] : null;
  const trajArrivalUtc = traj ? arrivalUtc(traj.response) : null;
  // SPICE Moon at the arrival instant (the "ghost" Moon) — same API as the scene state.
  const [arrivalMoon, setArrivalMoon] = useState<{ utc: string; position_m: number[] } | null>(null);
  useEffect(() => {
    setArrivalMoon(null);
    if (!trajArrivalUtc) return;
    let current = true;
    getCelestialState(new Date(trajArrivalUtc))
      .then((s) => current && setArrivalMoon({ utc: trajArrivalUtc, position_m: s.moon_from_earth.position_m }))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [trajArrivalUtc]);
  // "Play mission": from departure to the end of descent, the Moon and Sun moving with the date.
  const [missionPlay, setMissionPlay] = useState(false);
  useEffect(() => {
    if (missionPlay && trajEnd && date.getTime() >= trajEnd.t) {
      setPlaying(false);
      setMissionPlay(false);
      setDate(new Date(trajEnd.t));
    }
  }, [missionPlay, trajEnd, date]);
  useEffect(() => {
    if (!playing) setMissionPlay(false);
  }, [playing]);
  // The descent lasts ~2 h: slow to 1 h/s once it starts so the rocket can be seen landing.
  useEffect(() => {
    if (missionPlay && trajArrivalUtc && date.getTime() >= Date.parse(trajArrivalUtc) && speed > SPEEDS[0].hoursPerSecond)
      setSpeed(SPEEDS[0].hoursPerSecond);
  }, [missionPlay, trajArrivalUtc, date, speed]);
  const focusSeq = useRef(0);
  useEffect(() => {
    if (!focus || focus.seq === focusSeq.current) return;
    focusSeq.current = focus.seq;
    const d = new Date(focus.utc);
    if (Number.isNaN(d.getTime())) return;
    setPlaying(false);
    setDate(d);
    setAnchor(d);
  }, [focus]);
  const trajArrival = traj ? arrivalUtc(traj.response) : null;

  useEffect(() => {
    let current = true;
    getCelestialState(date)
      .then((s) => current && (setState(s), setError(null)))
      // No stale positions: a state for another date would be shown as if it were this one.
      .catch((e) => current && (setState(null), setError(e instanceof Error ? e.message : String(e))));
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
  const sceneShift = window.innerWidth < 640 ? 0 : centreShift(OVERLAY_RIGHT_PX, panelOpen ? PANEL_PX : 0);

  return (
    <div className={`dash${panelOpen ? "" : " panel-collapsed"}`}>
      {state ? (
        <CelestialScene
          state={state}
          view={view}
          enlargeBodies={enlargeBodies}
          active={active}
          onScale={setKmPerPx}
          offsetX={sceneShift}
          trajectory={view === "earth-moon" ? traj : null}
          arrivalMoon={arrivalMoon}
          footnote={
            <ScaleBar
              kmPerPx={view === "earth-moon" ? kmPerPx : null}
              note={`distances at Earth's centre${enlargeBodies ? `; radii ×${BODY_ENLARGEMENT}` : ""}`}
              fallback="Schematic — not to scale"
            />
          }
        />
      ) : (
        <div className="celestial-canvas placeholder">{error ? "Ephemerides unavailable" : "Loading…"}</div>
      )}

      {/* Top-left overlay: phase summary, view, time controls (same place as the scenario compass). */}
      <div className="dash-overlay">
        {state && (
          <div className="phase-row">
            <MoonPhaseIcon fraction={state.derived.illuminated_fraction} waxing={state.derived.waxing} size={44} />
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

        <div className="traj-box">
          <label className="small">
            Mission{" "}
            <select
              value={missions.find((m) => m.name === traj?.mission?.label)?.id ?? ""}
              disabled={trajBusy || missions.length === 0}
              onChange={(e) => {
                const m = missions.find((x) => x.id === Number(e.target.value));
                if (m) void computeForMission(m);
              }}
              aria-label="Mission"
            >
              <option value="">{missions.length ? "— pick a saved mission —" : "— no saved mission yet —"}</option>
              {missions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · landing {m.result.pre_landing.landing_utc.slice(0, 16).replace("T", " ")}
                </option>
              ))}
            </select>
          </label>
          {trajBusy && trajProgress && <div className="muted small">Computing… {trajProgress}</div>}
          {traj?.mission && (
            <div className="muted small">
              Mission “{traj.mission.label}”: end of descent {(() => {
                const g = ((traj.points.at(-1)?.t ?? 0) - Date.parse(traj.mission.landingUtc)) / 3_600_000;
                return `${g >= 0 ? "+" : "−"}${Math.abs(g).toFixed(1)} h`;
              })()} vs its planned landing.
            </div>
          )}
          <div className="muted small">…or a free trajectory from the date above:</div>
          <div className="traj-title">
            Trajectory Earth → site {Math.abs(site.latitude_deg).toFixed(2)}°{site.latitude_deg < 0 ? "S" : "N"}{" "}
            {Math.abs(site.longitude_deg).toFixed(2)}°{site.longitude_deg < 0 ? "W" : "E"}
          </div>
          <label className="small">
            transfer ≈{" "}
            <input type="number" min={2} max={10} step={0.5} value={transferDays} onChange={(e) => setTransferDays(Number(e.target.value))} aria-label="Target transfer duration, days" />{" "}
            d, departing at the date above
          </label>
          <button type="button" className="primary" disabled={trajBusy} onClick={computeTrajectory}>
            {trajBusy ? "Computing… (a few seconds)" : "Compute trajectory"}
          </button>
          {traj && trajEnd && (
            <div className="step-buttons">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setAbsolute(new Date(traj.points[0].t));
                  setSpeed(SPEEDS[2].hoursPerSecond);
                  setPlaying(true);
                  setMissionPlay(true);
                }}
              >
                ▶ Play mission
              </button>
              <button type="button" onClick={() => setAbsolute(new Date(traj.points[0].t))}>Departure</button>
              {trajArrival && <button type="button" onClick={() => setAbsolute(new Date(trajArrival))}>Arrival</button>}
              <button type="button" onClick={() => setAbsolute(new Date(trajEnd.t))}>End</button>
              <button type="button" onClick={() => setTraj(null)}>Clear</button>
            </div>
          )}
          {traj && trajArrival && (
            <div className="muted small">
              Departure {traj.response.segments[0].utc[0].slice(0, 16).replace("T", " ")} UTC · descent starts{" "}
              {trajArrival.slice(0, 16).replace("T", " ")} UTC · {((Date.parse(trajArrival) - traj.points[0].t) / DAY_MS).toFixed(2)} d.
              {traj.response.descent?.contact_detecte === false && (
                <span className="warn-text">
                  {" "}
                  Descent stopped without touchdown
                  {typeof traj.response.descent.altitude_sur_site_finale_km === "number" &&
                    ` (${(traj.response.descent.altitude_sur_site_finale_km as number).toFixed(0)} km above the site)`}
                  .
                </span>
              )}{" "}
              Demonstration model (details in ⋯).
            </div>
          )}
          {view !== "earth-moon" && traj && <div className="muted small">Shown in the Earth–Moon view only.</div>}
          {trajError && <div className="warn-text small">{trajError}</div>}
        </div>

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
                <Row k="Distance (centre–centre)" v={`${fmtKm(state.moon_from_earth.distance_m, 100)} · ${(state.moon_from_earth.distance_m / EARTH_MEAN_RADIUS_M).toFixed(1)} R⊕`} hint="Rounded to 100 km for display." />
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

            {traj && (
              <section className="small">
                <h2>Trajectory (vecteur-traj)</h2>
                <dl className="kv small">
                  <Row k="Status" v={traj.response.status} />
                  <Row k="Transfer" v={String(traj.response.transfer?.statut ?? "—")} />
                  <Row k="Descent" v={String(traj.response.descent?.statut ?? "—")} />
                  {typeof traj.response.descent?.distance_site_finale_m === "number" && (
                    <Row k="Final distance to site" v={`${((traj.response.descent.distance_site_finale_m as number) / 1000).toFixed(2)} km`} />
                  )}
                  {typeof traj.response.descent?.vitesse_finale_lunaire_ms === "number" && (
                    <Row k="Final speed (Moon frame)" v={`${(traj.response.descent.vitesse_finale_lunaire_ms as number).toFixed(1)} m/s`} />
                  )}
                  {typeof traj.response.descent?.delta_v_moteur_ms === "number" && (
                    <Row k="Descent Δv" v={`${Math.round(traj.response.descent.delta_v_moteur_ms as number)} m/s`} />
                  )}
                  <Row k="Frame" v={traj.response.frame?.name ?? "—"} />
                </dl>
                <ul className="small">
                  {traj.response.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
                <ul className="small warn-text">
                  {traj.response.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </section>
            )}

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
              <p className="muted small">
                Textures need the NASA data: <code>apps/web/scripts/setup-data.sh</code> —{" "}
                <a href={DATA_README_URL} target="_blank" rel="noopener noreferrer">
                  setup guide on GitHub
                </a>
                .
              </p>
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
