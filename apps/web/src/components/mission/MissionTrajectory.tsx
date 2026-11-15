// "Trajectory for this mission": Earth→Moon transfer + descent to the mission's site, departing the
// target transfer duration before its landing (POST /trajectory/simulate, vecteur-traj tool). The
// tool picks the transfer itself, so the computed end is compared with the planned landing.
import { useState } from "react";

import { api, ApiError } from "../../api/client";
import { computeMissionTrajectory, landingGapHours, MATCH_HOURS, MATCH_TRIES, missionDepartureUtc, type TrajectoryView } from "../../lib/trajectory";

const utc = (s: string) => `${s.slice(0, 16).replace("T", " ")} UTC`;


interface Props {
  site: { latitude_deg: number; longitude_deg: number };
  /** the mission's landing (with any injected delay) */
  landingUtc: string;
  /** the mission's name */
  label: string;
  /** the trajectory shown on the Sun · Earth · Moon page, if any */
  current: TrajectoryView | null;
  onComputed: (v: TrajectoryView) => void;
  /** open the Sun · Earth · Moon page at this instant */
  onShow: (focusUtc: string) => void;
}

export function MissionTrajectory({ site, landingUtc, label, current, onComputed, onShow }: Props) {
  const [days, setDays] = useState(4.5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const mine =
    current?.mission?.label === label &&
    current?.mission?.landingUtc === landingUtc &&
    current.response.request.site.latitude_deg === site.latitude_deg &&
    current.response.request.site.longitude_deg === site.longitude_deg
      ? current
      : null;
  const departure = missionDepartureUtc(landingUtc, days);

  const compute = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await computeMissionTrajectory(api.trajectorySimulate, { name: label, site, landingUtc, transferDays: days }, setProgress);
      onComputed(res.view);
    } catch (e) {
      setError(e instanceof ApiError && e.body ? `${e.body.error.code}: ${e.body.error.message}` : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const gap = mine ? landingGapHours(mine, landingUtc) : null;
  const arrival = mine?.response.segments.find((s) => s.phase === "descent")?.utc[0] ?? null;
  const end = mine?.points.at(-1);
  const contact = mine?.response.descent?.contact_detecte;

  return (
    <div className="mission-trajectory">
      <h3>Trajectory for “{label}”</h3>
      <p className="muted small">
        Earth → site, departing {utc(departure)} (landing {utc(landingUtc)} minus a transfer of about{" "}
        <input type="number" min={2} max={10} step={0.5} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Transfer duration, days" /> d).
        The tool chooses the exact transfer: the departure is then shifted by the gap and recomputed (up to {MATCH_TRIES} runs) to end
        within {MATCH_HOURS} h of the planned landing when it can.
      </p>
      <div className="actions">
        <button type="button" disabled={busy} onClick={compute}>
          {busy ? `Computing… ${progress ?? ""}` : mine ? "Recompute trajectory" : "Compute trajectory"}
        </button>
        {mine && arrival && (
          <button type="button" className="primary" onClick={() => onShow(arrival)}>
            View on Sun · Earth · Moon
          </button>
        )}
      </div>
      {mine && end && (
        <dl className="kv small">
          <dt>Departure (used)</dt>
          <dd>{utc(mine.response.segments[0].utc[0])}</dd>
          {arrival && (
            <>
              <dt>Descent starts</dt>
              <dd>{utc(arrival)}</dd>
            </>
          )}
          <dt>End of descent</dt>
          <dd>
            {utc(new Date(end.t).toISOString())} {contact === true ? "(touchdown)" : contact === false ? "(time limit, no touchdown)" : ""}
          </dd>
          <dt>vs planned landing</dt>
          <dd className={gap !== null && Math.abs(gap) > 6 ? "warn-text" : ""}>
            {gap === null ? "—" : `${gap >= 0 ? "+" : "−"}${Math.abs(gap).toFixed(1)} h`}
          </dd>
        </dl>
      )}
      {mine && <p className="muted small">Demonstration model (unlimited propellant, spherical Moon): {mine.response.warnings.length} warning(s) on the Sun · Earth · Moon page (⋯).</p>}
      {error && <div className="warn-text small">{error}</div>}
    </div>
  );
}
