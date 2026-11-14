// Terrain slope map around the scenario site, from the derived LOLA 20 m slope tiles
// (services/science/tools/slope_tiles.cpp → public/data/polar_s_slope/). The "max slope" slider
// only recolours pixels already in memory: no request, no recomputation.
//
// Drawn on the native polar-stereographic grid (no resampling, no pole singularity): canvas up =
// image up (decreasing line); the north arrow shows local geographic north at the site.
//
// "Verify on server" asks the science service (via the gateway) to re-check a circular zone around
// the site on the full-resolution raw DEM; the tiles shown here are only a preview.

import { useEffect, useMemo, useRef, useState } from "react";

import { ApiError, api } from "../api/client";
import type { SlopeCheckResponse } from "../api/types";
import { DEG } from "../lib/constants";
import { polarPixel, toLevel } from "./polarDem";
import { loadSlopeProduct, type SlopeProduct } from "./slopeProduct";

const N = 320; // canvas pixels
const HALF_WIDTHS_KM = [1, 2, 5, 10, 25, 50];
const RADII_M = [100, 250, 500, 1000, 2000, 5000, 10000];

/** One server check; `key` = the settings it was run with (to flag a stale result). */
interface Check {
  key: string;
  loading?: boolean;
  res?: SlopeCheckResponse;
  error?: string;
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 503) return "Science service unavailable (the gateway could not reach it).";
    if (e.status === 422) return `Request rejected: ${e.body?.error.details.map((d) => `${d.field} ${d.issue}`).join("; ") ?? e.message}`;
    return `Server error (HTTP ${e.status}): ${e.message}`;
  }
  return "API gateway unreachable: is services/api running on :8080?";
}

interface Grid {
  /** slope (degrees) per canvas pixel, NaN = no data / not loaded */
  slope: Float32Array;
  level: number;
  levelScaleM: number;
  /** clockwise angle (degrees) from canvas-up to local north at the site */
  northDeg: number;
  /** map metres per canvas pixel, site level-0 pixel, level-0 scale, point scale factor at the site */
  mpp: number;
  p0: { line: number; sample: number };
  scale0: number;
  k: number;
}

interface Props {
  siteLat: number;
  siteLon: number;
  /** max slope (degrees), shared with the globe slope disc */
  maxSlope: number;
  onMaxSlope: (deg: number) => void;
}

export function SlopeMap({ siteLat, siteLon, maxSlope, onMaxSlope: setMaxSlope }: Props) {
  const [prod, setProd] = useState<SlopeProduct | null | undefined>(undefined);
  const [halfKm, setHalfKm] = useState(5);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [radiusM, setRadiusM] = useState(500);
  const [check, setCheck] = useState<Check | null>(null);
  const checkSeq = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const siteKey = `${siteLat},${siteLon}`;
  const checkKey = `${siteKey},${radiusM},${maxSlope}`;

  const verify = () => {
    const seq = ++checkSeq.current;
    const key = checkKey;
    setCheck({ key, loading: true });
    api
      .slopeCheck({ zone: { center_latitude_deg: siteLat, center_longitude_deg: siteLon, radius_m: radiusM }, max_slope_deg: maxSlope })
      .then((res) => seq === checkSeq.current && setCheck({ key, res }))
      .catch((e) => seq === checkSeq.current && setCheck({ key, error: describeError(e) }));
  };

  useEffect(() => {
    loadSlopeProduct().then(setProd);
  }, []);

  const covered = prod ? prod.dem.covers(siteLat, siteLon) : false;

  // Fetch the tiles for the view, then sample them once into a per-canvas-pixel slope grid.
  useEffect(() => {
    if (!prod || !covered) return setGrid(null);
    let stale = false;
    const { dem, manifest: m } = prod;
    const mpp = (2 * halfKm * 1000) / N;
    const level = Math.min(dem.levelForSpacing(mpp), m.levels.length - 1);
    const L = m.levels[level];
    setGrid(null);
    dem
      .loadAround(siteLat, siteLon, [{ level, radiusM: halfKm * 1000 * Math.SQRT2 }], (done, total) => !stale && setProgress({ done, total }))
      .then(() => {
        if (stale) return;
        const p0 = polarPixel(dem.manifest, siteLat, siteLon);
        const l0 = toLevel(p0.line, level);
        const s0 = toLevel(p0.sample, level);
        const f = mpp / L.scale_m; // level pixels per canvas pixel
        const slope = new Float32Array(N * N);
        for (let y = 0; y < N; y++)
          for (let x = 0; x < N; x++)
            slope[y * N + x] = dem.pixelValue(level, Math.round(l0 + (y - N / 2 + 0.5) * f), Math.round(s0 + (x - N / 2 + 0.5) * f));
        // Local north in image (right, up) coordinates — manifest projection.aspect_to_geographic.
        const p = m.projection;
        const dl = (siteLat <= -90 ? 0 : siteLon - p.center_lon) * DEG;
        const north = { right: Math.sin(dl), up: -p.sign_line * p.sign_y * Math.cos(dl) };
        const scale0 = m.levels[0].scale_m;
        const rho = Math.hypot((p0.sample - p.sample_off) * scale0, (p0.line - p.line_off) * scale0);
        setGrid({
          slope,
          level,
          levelScaleM: L.scale_m,
          northDeg: Math.atan2(north.right, north.up) / DEG,
          mpp,
          p0,
          scale0,
          k: 1 + (rho / (2 * p.radius_m)) ** 2,
        });
        setProgress(null);
      });
    return () => {
      stale = true;
    };
  }, [prod, covered, siteLat, siteLon, halfKm]);

  // Recolour on every slider move: pure CPU pass over N² pixels (~1 ms), no fetch.
  const stats = useMemo(() => {
    if (!grid) return null;
    let ok = 0;
    let valid = 0;
    for (const v of grid.slope) {
      if (Number.isNaN(v)) continue;
      valid++;
      if (v <= maxSlope) ok++;
    }
    return { ok, valid, nodata: grid.slope.length - valid };
  }, [grid, maxSlope]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !grid) return;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(N, N);
    const d = img.data;
    for (let i = 0; i < grid.slope.length; i++) {
      const v = grid.slope[i];
      const o = i * 4;
      if (Number.isNaN(v)) {
        d[o] = d[o + 1] = d[o + 2] = 70; // no data: grey, never "flat"
      } else if (v <= maxSlope) {
        const t = maxSlope > 0 ? v / maxSlope : 0; // flatter = brighter green
        d[o] = 20 + 40 * t;
        d[o + 1] = 210 - 110 * t;
        d[o + 2] = 90 - 40 * t;
      } else {
        const t = Math.min(1, (v - maxSlope) / 20);
        d[o] = 170 + 85 * t;
        d[o + 1] = 40 - 30 * t;
        d[o + 2] = 40 - 30 * t;
      }
      d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // site marker
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(N / 2, N / 2, 5, 0, 2 * Math.PI);
    ctx.stroke();
    // zone to verify: ground radius -> map metres (x k, conformal) -> canvas pixels
    ctx.strokeStyle = "#5cc8ff";
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(N / 2, N / 2, (radiusM * grid.k) / grid.mpp, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
    // steepest pixel found by the server check (same site only)
    const w = check?.res?.stats?.worst_pixel;
    if (w && prod && check.key.startsWith(`${siteKey},`)) {
      const pw = polarPixel(prod.dem.manifest, w.latitude_deg, w.longitude_deg);
      const f = grid.scale0 / grid.mpp;
      const x = N / 2 + (pw.sample - grid.p0.sample) * f;
      const y = N / 2 + (pw.line - grid.p0.line) * f;
      ctx.strokeStyle = "#ff3df2";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, 2 * Math.PI);
      ctx.moveTo(x - 10, y);
      ctx.lineTo(x + 10, y);
      ctx.moveTo(x, y - 10);
      ctx.lineTo(x, y + 10);
      ctx.stroke();
    }
  }, [grid, maxSlope, radiusM, check, prod, siteKey]);

  if (prod === undefined) return <p className="muted small">Loading slope product…</p>;
  if (prod === null)
    return (
      <p className="muted small">
        Slope tiles not installed. Build them with <code>slope-tiles</code> (see <code>apps/web/scripts/POLAR_DATA.md</code>).
      </p>
    );
  if (!covered) return <p className="muted small">Site outside the {prod.productId} coverage (85°S–90°S): no slope data here.</p>;

  const pct = stats && stats.valid > 0 ? (100 * stats.ok) / stats.valid : null;
  const scaleKm = halfKm >= 5 ? halfKm / 5 : halfKm / 2; // bar length
  return (
    <div className="slope-map">
      <label className="slider">
        Max slope <output>{maxSlope.toFixed(1)}°</output>
        <input type="range" min={0.5} max={45} step={0.5} value={maxSlope} onChange={(e) => setMaxSlope(Number(e.target.value))} />
      </label>
      <label className="select">
        View
        <select value={halfKm} onChange={(e) => setHalfKm(Number(e.target.value))}>
          {HALF_WIDTHS_KM.map((h) => (
            <option key={h} value={h}>
              {2 * h} × {2 * h} km
            </option>
          ))}
        </select>
      </label>
      <div className="slope-canvas-wrap">
        <canvas ref={canvasRef} width={N} height={N} aria-label="Terrain slope map around the site" />
        {grid && (
          <>
            <div className="slope-north" style={{ transform: `rotate(${grid.northDeg}deg)` }} title="Local north at the site">
              ▲<span>N</span>
            </div>
            <div className="slope-scale" style={{ width: `${((scaleKm / (2 * halfKm)) * 100).toFixed(1)}%` }}>
              {scaleKm} km
            </div>
          </>
        )}
        {!grid && <div className="slope-loading">{progress ? `Loading slope tiles ${progress.done}/${progress.total}…` : "Loading…"}</div>}
      </div>
      {stats && (
        <p className="small">
          <span className="slope-ok">■</span> ≤ {maxSlope.toFixed(1)}°: <strong>{pct != null ? pct.toFixed(1) : "—"} %</strong> of the view ·{" "}
          <span className="slope-bad">■</span> steeper
          {stats.nodata > 0 && <> · <span className="slope-nodata">■</span> no data {((100 * stats.nodata) / (N * N)).toFixed(1)} %</>}
        </p>
      )}
      <div className="slope-verify">
        <label className="select">
          Zone radius
          <select value={radiusM} onChange={(e) => setRadiusM(Number(e.target.value))}>
            {RADII_M.map((r) => (
              <option key={r} value={r}>
                {r >= 1000 ? `${r / 1000} km` : `${r} m`}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={verify} disabled={check?.loading}>
          {check?.loading ? "Checking…" : "Verify on server"}
        </button>
      </div>
      {check && !check.loading && <SlopeCheckResult check={check} stale={check.key !== checkKey} />}
      {grid && (
        <p className="muted small">
          {prod.productId}, slope on a {prod.manifest.method.baseline_m} m baseline (Horn 3×3), shown at level L{grid.level} (
          {grid.levelScaleM} m/px{grid.level > 0 ? ", max of finer pixels: conservative" : ""}). Green = slope criterion met at DEM scale, NOT a
          validated landing site: boulders and craters smaller than ~20–60 m are invisible. {prod.manifest.status}.
        </p>
      )}
    </div>
  );
}

const VERDICT_TEXT: Record<SlopeCheckResponse["verdict"], string> = {
  pass: "PASS",
  fail: "FAIL",
  insufficient_data: "INSUFFICIENT DATA",
  not_evaluated: "NOT EVALUATED",
};

function SlopeCheckResult({ check, stale }: { check: Check; stale: boolean }) {
  if (check.error) return <p className="small slope-verdict-fail">{check.error}</p>;
  const r = check.res!;
  const q = r.request;
  const st = r.stats;
  const radius = q.zone.radius_m >= 1000 ? `${q.zone.radius_m / 1000} km` : `${q.zone.radius_m} m`;
  const deg = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(1)}°`);
  return (
    <div className="slope-check small">
      <p>
        <strong className={`slope-verdict-${r.verdict}`}>{VERDICT_TEXT[r.verdict]}</strong> · server check, zone r = {radius}, max{" "}
        {q.max_slope_deg.toFixed(1)}°, required {(100 * q.required_fraction).toFixed(0)} % of valid pixels
        {stale && <span className="muted"> (settings changed since: verify again)</span>}
      </p>
      {r.status === "dem_unavailable" && (
        <p className="muted">Science service has no DEM loaded ({String(r.data_provenance.reason ?? "")}). Nothing was computed.</p>
      )}
      {r.status === "out_of_coverage" && <p className="muted">Zone not fully inside the {r.data_provenance.dem_product} coverage: nothing was computed.</p>}
      {st && (
        <p>
          {(100 * st.fraction_ok).toFixed(1)} % of {st.pixel_count - st.nodata_count} valid pixels ≤ {q.max_slope_deg.toFixed(1)}° · max{" "}
          {deg(st.slope_max_deg)} (<span className="slope-worst">⊕</span> on map) · p95 {deg(st.slope_p95_deg)} · mean {deg(st.slope_mean_deg)}
          {st.nodata_count > 0 && <> · no data {st.nodata_count} px</>}
        </p>
      )}
      {r.status !== "dem_unavailable" && (
        <p className="muted">
          {r.data_provenance.dem_product}
          {r.data_provenance.dem_sha256 ? ` (sha256 ${r.data_provenance.dem_sha256.slice(0, 12)}…)` : ""}, {r.model.method}, {r.model.baseline_m} m baseline,{" "}
          {r.model.body_fixed_frame}.
        </p>
      )}
      <details>
        <summary>Warnings and assumptions ({r.warnings.length + r.assumptions.length})</summary>
        <ul>
          {r.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
          {r.assumptions.map((a) => (
            <li key={a} className="muted">
              {a}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
