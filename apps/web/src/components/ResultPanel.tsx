import { memo } from "react";

import type { ScenarioResponse, VisibilityWindow } from "../api/types";
import { HorizonProfile } from "./HorizonProfile";
import { Timeline } from "./Timeline";

function WindowList({ title, windows }: { title: string; windows: VisibilityWindow[] }) {
  return (
    <div>
      <h4>{title}</h4>
      {windows.length === 0 ? (
        <p className="muted">none in sampled range</p>
      ) : (
        <ul className="windows">
          {windows.map((w) => (
            <li key={w.start_utc}>
              {w.clipped_start ? "≤ " : ""}
              {w.start_utc} → {w.end_utc}
              {w.clipped_end ? " ≥" : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Notes({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <details open>
      <summary>{title}</summary>
      <ul>
        {items.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </details>
  );
}

export const ResultPanel = memo(function ResultPanel({ result }: { result: ScenarioResponse }) {
  const { status, synthetic, model } = result;
  return (
    <section className={synthetic ? "result synthetic" : "result"}>
      {synthetic && (
        <div className="synthetic-banner" role="alert">
          SYNTHETIC DEMO DATA — arbitrary waveforms, NOT the real Sun or Earth. Do not use for analysis.
        </div>
      )}
      <header className="result-head">
        <span className={`status status-${status}`}>{status.replace("_", " ")}</span>
        <span>{result.message}</span>
      </header>
      <dl className="model">
        <dt>Ephemeris provider</dt>
        <dd>{model.ephemeris_provider}</dd>
        <dt>Horizon model</dt>
        <dd>{model.horizon_model === "ideal_geometric" ? "Ideal geometric horizon" : "DEM terrain horizon"}</dd>
        <dt>Body-fixed frame</dt>
        <dd>{model.body_fixed_frame ?? "— (none used)"}</dd>
        <dt>Time scale</dt>
        <dd>{model.time_scale_note}</dd>
        <dt>Kernels</dt>
        <dd>{model.kernel_set.length ? model.kernel_set.join(", ") : "— (none loaded)"}</dd>
      </dl>

      {result.samples.length > 1 && (
        <>
          <div className="legend">
            <span className="sw sun" /> Sun centre elevation <span className="sw earth" /> Earth centre elevation
            <span className="muted">
              {" "}· bars = above the {result.terrain_horizon ? "terrain" : "ideal"} horizon (geometric only — not power or link availability)
              {result.terrain_horizon && <> · dashed = terrain horizon at the body's azimuth</>}
            </span>
          </div>
          <Timeline
            samples={result.samples}
            sunWindows={result.windows.sun_visible}
            earthWindows={result.windows.earth_visible}
            watermark={synthetic ? "SYNTHETIC" : undefined}
          />
          {result.terrain_horizon && (
            <>
              <h4>Terrain horizon from the site</h4>
              <HorizonProfile terrain={result.terrain_horizon} samples={result.samples} />
              <p className="muted small">
                Skyline elevation versus azimuth; dots = Sun (yellow) and Earth (blue) centres over the scenario. Ground at the
                site: {result.terrain_horizon.site_surface_height_m.toFixed(0)} m relative to the 1737.4 km sphere. Rays traced
                to {(result.terrain_horizon.max_range_m / 1000).toFixed(0)} km
                {result.terrain_horizon.truncated_bearing_fraction > 0 && (
                  <>
                    ; {(result.terrain_horizon.truncated_bearing_fraction * 100).toFixed(0)} % of directions leave the DEM
                    earlier (from {(result.terrain_horizon.min_covered_range_m / 1000).toFixed(0)} km): terrain beyond is unknown
                  </>
                )}
                .
              </p>
            </>
          )}
          <div className="grid2">
            <WindowList title="Sun above horizon" windows={result.windows.sun_visible} />
            <WindowList title="Earth above horizon" windows={result.windows.earth_visible} />
          </div>
        </>
      )}

      <Notes title="Warnings" items={result.warnings} />
      <Notes title="Assumptions" items={result.assumptions} />
      <Notes title="Data provenance" items={result.data_provenance.map((p) => `${p.name} [${p.kind}] — ${p.source}. ${p.notes}`)} />
    </section>
  );
});
