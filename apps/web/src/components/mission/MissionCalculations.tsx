// "Show calculations": walks through what the science service computed for this run (services/science/src/
// mission.cpp, evaluate.cpp, radio.cpp), with the numbers of THIS response. Method text mirrors the C++ code;
// every value shown comes from the response, except the worked battery step, re-done here only to show the method.
import type { MissionResponse } from "../../api/missionTypes";
import { workedEnergyStep } from "../../lib/mission";
import { formatDuration } from "../../lib/radio";

/** Same constant as SOLAR_CONSTANT_W_M2 in services/science (TSI at 1 AU), used only for the peak-power line. */
const S0 = 1361;

const f = (v: number | null | undefined, d = 1) => (v == null || !Number.isFinite(v) ? "—" : (+v.toFixed(d)).toLocaleString("en-US"));
const utc = (s: string) => s.slice(0, 16).replace("T", " ") + " UTC";
const COS_I = {
  sun_tracking: "cos i = 1 (panel always faces the Sun)",
  vertical: "cos i = cos(Sun elevation) (vertical panel turned to the Sun's azimuth)",
  horizontal: "cos i = sin(Sun elevation) (flat panel)",
} as const;

export function MissionCalculations({ result }: { result: MissionResponse }) {
  const { request: rq, model, inventory: inv, pre_landing: pre } = result;
  const p = rq.power ?? null;
  const step = workedEnergyStep(result);
  const n = result.timeline.length;
  const dem = model.horizon_model === "dem_terrain";
  const kernels = Array.isArray(model.kernel_set) ? (model.kernel_set as string[]) : [];

  return (
    <div className="mission-calc small">
      <p className="muted">
        What the science service did for this run, step by step, with this run's numbers. Every result below was computed by the C++ service; the browser only
        displays it.
      </p>
      <ol>
        <li>
          <h4>Time grid</h4>
          <p>
            Site {f(rq.site.latitude_deg, 4)}° lat (planetocentric), {f(rq.site.longitude_deg, 4)}° lon (east-positive), {f(rq.site.observer_height_m)} m above the
            1737.4 km reference sphere.
          </p>
          <p>
            Landing {utc(pre.landing_utc)}
            {pre.landing_delay_hours > 0 && ` (planned ${utc(pre.planned_landing_utc)} + ${f(pre.landing_delay_hours)} h delay, policy "${pre.end_policy}")`}, then one sample
            every {rq.step_minutes} min → <strong>{n} samples</strong>
            {inv && ` over ${formatDuration(inv.surface_hours)}`}.
          </p>
          {typeof model.time_scale_note === "string" && <p className="muted">{model.time_scale_note}</p>}
        </li>

        <li>
          <h4>Sun and Earth direction at each sample</h4>
          {result.synthetic ? (
            <p className="warn">SYNTHETIC ephemerides: directions come from a made-up model for UI testing, not from real positions.</p>
          ) : (
            <p>
              Ephemeris <code>{model.ephemeris_provider}</code>, body-fixed frame <code>{String(model.body_fixed_frame ?? "—")}</code>
              {kernels.length > 0 && <>, kernels {kernels.map((k) => <code key={k}>{k} </code>)}</>}.
            </p>
          )}
          <p>
            For each sample: vector site → Sun centre and site → Earth centre (corrected for light time and stellar aberration), rotated into the local East-North-Up
            frame. <code>elevation = asin(up)</code>, <code>azimuth = atan2(east, north)</code> (from north toward east).
          </p>
          <p>
            Visible ⇔ elevation &gt; horizon elevation —{" "}
            {dem ? "the horizon is read from the LOLA terrain model in the body's direction." : "the horizon is ideal (0°): terrain is ignored."} Window edges are
            interpolated linearly between samples.
          </p>
          {inv && (
            <p>
              → Sun visible <strong>{formatDuration(inv.energy.sun_hours)}</strong> (longest night {formatDuration(inv.energy.longest_sun_outage_hours)}) · Earth visible{" "}
              <strong>{formatDuration(inv.comms.earth_visible_hours)}</strong> (longest gap {formatDuration(inv.comms.longest_earth_outage_hours)}).
            </p>
          )}
        </li>

        <li>
          <h4>Contact with Earth</h4>
          {rq.radio ? (
            <>
              <p>
                Link available ⇔ Earth above {f(rq.radio.min_earth_elevation_deg)}° at the site <em>and</em> the Moon above the mask of at least one of{" "}
                {rq.radio.stations.length} ground stations <em>and</em> link margin &gt; 0 dB (Eb/N0 from EIRP {f(rq.radio.link.eirp_dbw)} dBW, G/T{" "}
                {f(rq.radio.link.rx_g_over_t_db_k)} dB/K, free-space loss, ≥ {f(rq.radio.link.required_ebn0_db)} dB required).
                {dem && " Then intersected with the Earth visibility above the terrain horizon."}
              </p>
              <p className="muted">Uses a low-precision analytic Moon ephemeris (Meeus), not SPICE: about 0.04° from SPICE.</p>
              {inv && (
                <p>
                  → link {formatDuration(inv.comms.link_hours ?? NaN)} · data volume = link hours × {f(rq.radio.link.data_rate_bps / 1000)} kbit/s ={" "}
                  <strong>{f(inv.comms.data_volume_mbit, 0)} Mbit</strong>.
                </p>
              )}
            </>
          ) : (
            <p>No radio model: contact = geometric Earth visibility (step 2). It is not a guaranteed radio link, and no data volume is computed.</p>
          )}
          <p className="muted">Longest gap = the longest stretch without contact, including before the first and after the last window.</p>
        </li>

        <li>
          <h4>Energy</h4>
          {!p ? (
            <p>Not modelled (power off). Sun hours are still reported in step 2.</p>
          ) : (
            <>
              <p>
                <code>P_solar = S0 × area × efficiency × cos i</code> while the Sun's centre is visible, else 0. S0 = {S0} W/m², {COS_I[p.panel_pointing]}.
                <br />
                Here: {S0} × {p.panel_area_m2} m² × {f(p.panel_efficiency * 100, 2)} % = <strong>{f(S0 * p.panel_area_m2 * p.panel_efficiency, 0)} W</strong> at cos i = 1.
              </p>
              <p>
                Battery at landing: <code>E0 = SoC0 × C − P_wait × delay / η_dis</code> = {f(p.battery_initial_soc * 100)} % × {f(p.battery_capacity_wh, 0)} Wh
                {pre.net_load_w != null && pre.landing_delay_hours > 0 ? ` − ${f(pre.net_load_w)} W × ${f(pre.landing_delay_hours)} h / ${p.discharge_efficiency}` : ""} →{" "}
                <strong>{f((pre.soc_at_landing ?? NaN) * 100)} %</strong>.
              </p>
              <p>
                Each step Δt: <code>gen = (P[i−1] + P[i]) / 2</code>, <code>net = gen − load</code>; if net ≥ 0, <code>E += net × η_ch × Δt</code> (excess above full is
                wasted); else <code>E −= |net| × Δt / η_dis</code> (below empty, the load is not supplied). Load {f(p.load_w)} W, η_ch {p.charge_efficiency}, η_dis{" "}
                {p.discharge_efficiency}.
              </p>
              {step && (
                <p className="mission-calc-example">
                  Example, {utc(step.from)} → {utc(step.to)} (Δt {f(step.dtH, 3)} h): gen = ({f(step.solarPrevW)} + {f(step.solarW)}) / 2 = {f(step.genW)} W, net ={" "}
                  {f(step.netW)} W → E = {f(step.prevWh)} {step.netW >= 0 ? `+ ${f(step.netW)} × ${p.charge_efficiency}` : `− ${f(-step.netW)} / ${p.discharge_efficiency}`} ×{" "}
                  {f(step.dtH, 3)} = <strong>{f(step.nextWh)} Wh</strong>{" "}
                  <span className="muted">(service returned {f(step.returnedWh)} Wh; recomputed in the browser only to show the method)</span>
                </p>
              )}
              {inv && (
                <p>
                  → generated {f((inv.energy.generated_wh ?? NaN) / 1000, 2)} kWh · load {f((inv.energy.load_wh ?? NaN) / 1000, 2)} kWh · wasted (battery full){" "}
                  {f(inv.energy.curtailed_wh, 0)} Wh · not supplied {f(inv.energy.unserved_wh, 0)} Wh · min SoC {f((inv.energy.min_soc ?? NaN) * 100)} %.
                </p>
              )}
              {inv?.sizing && (
                <p>
                  Sizing: the whole energy run is repeated in a bisection to find the smallest battery (1 Wh steps, up to 10 GWh) and the smallest array (0.01 m², up to
                  1000 m²) that keep the battery ≥ {f(inv.sizing.reserve_soc * 100, 0)} % with the load always supplied → battery{" "}
                  {inv.sizing.required_battery_wh == null ? "none found" : `${f(inv.sizing.required_battery_wh, 0)} Wh`}, array{" "}
                  {inv.sizing.required_panel_area_m2 == null ? "none found" : `${f(inv.sizing.required_panel_area_m2, 2)} m²`}.
                </p>
              )}
              <p className="muted">Not modelled: ±3.4 % Sun–Moon distance variation, partial solar disc, dust, temperature, ageing.</p>
            </>
          )}
        </li>

        {inv?.slope && (
          <li>
            <h4>Landing slope</h4>
            <p>
              Slope of every 20 m pixel of the LOLA terrain model (Horn 3×3 finite differences) within {f(inv.slope.radius_m / 1000)} km of the site; share of pixels ≤{" "}
              {inv.slope.max_slope_deg}°.{" "}
              {inv.slope.status === "computed"
                ? `→ ${f((inv.slope.fraction_ok ?? NaN) * 100)} % · mean ${f(inv.slope.slope_mean_deg)}° · max ${f(inv.slope.slope_max_deg)}°.`
                : `→ not available (${inv.slope.status}).`}
            </p>
            <p className="muted">Pixel slope, not the slope under the lander's footprint.</p>
          </li>
        )}

        <li>
          <h4>Constraints → verdict</h4>
          <ul>
            {result.constraints.map((c) => (
              <li key={c.id}>
                {c.label}: {c.value == null ? "—" : f(c.value, 3)} vs limit {c.limit == null ? "—" : f(c.limit, 3)} →{" "}
                <span className={c.status === "pass" ? "slope-ok" : c.status === "fail" ? "slope-bad" : "muted"}>{c.status.replace("_", " ")}</span>
              </li>
            ))}
            {result.constraints.length === 0 && <li className="muted">No constraint applied.</li>}
          </ul>
          <p>
            Rule: any fail → NO GO; otherwise any “not evaluated” → INCOMPLETE; otherwise GO. → <strong>{result.verdict.replace("_", " ").toUpperCase()}</strong>.
          </p>
        </li>

        {(result.corrections.length > 0 || result.date_scan) && (
          <li>
            <h4>Corrections</h4>
            <p>
              {result.corrections.length} option(s). Each changed mission (later landing, other date, site moved ≤ 10 km, smaller slope limit, shorter stay, bigger
              battery or array) was <strong>simulated again from step 1</strong> with the same models before being offered.
              {result.date_scan &&
                ` Date scan: ${result.date_scan.points.length} re-simulations, every ${result.date_scan.step_hours} h within ±${f(result.date_scan.range_hours / 24, 0)} days.`}
            </p>
          </li>
        )}

        <li>
          <h4>Data sources</h4>
          {result.data_provenance.length ? (
            <ul>
              {result.data_provenance.map((d, i) => (
                <li key={i}>
                  <strong>{String(d.name ?? d.kind ?? "source")}</strong>
                  {typeof d.source === "string" && (
                    <>
                      {" — "}
                      {d.source.startsWith("http") ? <a href={d.source} target="_blank" rel="noopener noreferrer">{d.source}</a> : d.source}
                    </>
                  )}
                  {typeof d.notes === "string" && <div className="muted">{d.notes}</div>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">None reported.</p>
          )}
        </li>
      </ol>
    </div>
  );
}
