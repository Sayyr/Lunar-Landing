// "Standing on the site" view: overlay over the orbit globe, sharing the scenario time bar and the
// compass. Terrain rebuilt when the site, the observer height or the streamed DEM changes.

import { useEffect, useRef, useState } from "react";

import { buildGroundTerrain, type TerrainSource } from "./groundTerrain";
import { type GroundSky, GroundView, type GroundViewState } from "./groundView";
import type { Heightmap } from "./heightmap";
import { DATA_BASE, loadJson } from "./loaders";
import { POLAR_PLAN, PolarDem, polarLevelFor, type PolarManifest } from "./polarDem";
import type { AzEl } from "./skyGeometry";

// High-resolution south-polar DEM (scripts/setup-polar-dem.sh), shared by every ground view of the
// page so tiles are fetched once. null = not installed.
const POLAR_BASE = `${DATA_BASE}polar_s/`;
let polarPromise: Promise<PolarDem | null> | null = null;
const loadPolar = () =>
  (polarPromise ??= loadJson<PolarManifest>(`${POLAR_BASE}manifest.json`)
    .then((m) => new PolarDem(m, POLAR_BASE))
    .catch(() => null));

/** Polar DEM near the observer (finest level allowed by the distance), global raster elsewhere. */
function terrainSource(hm: Heightmap | null, polar: PolarDem | null): TerrainSource {
  if (!polar) return hm;
  return (lat, lon, d) => {
    const lv = polarLevelFor(d);
    if (lv >= 0) {
      const v = polar.sampleKm(lat, lon, lv);
      if (Number.isFinite(v)) return v * 1000;
    }
    return hm ? hm.sampleKmSmooth(lat, lon) * 1000 : 0;
  };
}

interface Props {
  heightmap: Heightmap | null;
  siteLat: number;
  siteLon: number;
  observerHeightM: number;
  sky: GroundSky | null;
  /** bumped when streamed DEM bands arrive: rebuild the terrain */
  demVersion: number;
  active: boolean;
  onExit: () => void;
  /** view azimuth (degrees), e.g. to turn the compass so its top is where the observer looks */
  onHeading?: (azimuthDeg: number) => void;
}

const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const CARD = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** Heading tape: ticks over the horizontal field of view, Sun/Earth markers or edge arrows. */
function HeadingTape({ view, sun, earth }: { view: GroundViewState; sun?: AzEl; earth?: AzEl }) {
  const W = 560;
  const x = (az: number) => (wrap180(az - view.azimuthDeg) / view.hfovDeg + 0.5) * W;
  const ticks = [];
  const start = Math.floor((view.azimuthDeg - view.hfovDeg / 2) / 5) * 5;
  for (let a = start; a <= view.azimuthDeg + view.hfovDeg / 2; a += 5) {
    const az = ((a % 360) + 360) % 360;
    const px = x(az);
    if (px < 0 || px > W) continue;
    const major = az % 45 === 0;
    ticks.push(
      <g key={a}>
        <line x1={px} x2={px} y1={major ? 14 : az % 15 === 0 ? 18 : 21} y2={26} stroke={az === 0 ? "#ff4d4d" : "#cfd6e4"} strokeWidth={major ? 1.6 : 1} />
        {major && (
          <text x={px} y={11} textAnchor="middle" fontSize={11} fontWeight={700} fill={az === 0 ? "#ff4d4d" : "#e6e8ee"}>
            {CARD[az / 45]}
          </text>
        )}
        {!major && az % 15 === 0 && (
          <text x={px} y={12} textAnchor="middle" fontSize={9} fill="#8a93a6">
            {az}
          </text>
        )}
      </g>,
    );
  }
  const marker = (v: AzEl | undefined, color: string, label: string) => {
    if (!v) return null;
    const d = wrap180(v.azimuthDeg - view.azimuthDeg);
    if (Math.abs(d) <= view.hfovDeg / 2) return <circle cx={x(v.azimuthDeg)} cy={31} r={4} fill={color}><title>{label}</title></circle>;
    const left = d < 0;
    return (
      <text x={left ? 4 : W - 4} y={35} textAnchor={left ? "start" : "end"} fontSize={11} fill={color}>
        {left ? `◀ ${label}` : `${label} ▶`}
      </text>
    );
  };
  return (
    <svg className="heading-tape" viewBox={`0 0 ${W} 40`} width={W} height={40} role="img" aria-label="Heading">
      {ticks}
      <path d={`M${W / 2 - 5} 0 L${W / 2 + 5} 0 L${W / 2} 6 Z`} fill="#fff" />
      {marker(sun, "#ffd400", "Sun")}
      {marker(earth, "#4aa3ff", "Earth")}
    </svg>
  );
}

export function GroundViewPanel({ heightmap, siteLat, siteLon, observerHeightM, sky, demVersion, active, onExit, onHeading }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<GroundView | null>(null);
  const [state, setState] = useState<GroundViewState>({ azimuthDeg: 0, elevationDeg: 5, hfovDeg: 90 });
  const [siteElevationM, setSiteElevationM] = useState<number | null>(null);
  /** null: polar DEM not used here; otherwise its loading state for this site */
  const [polar, setPolar] = useState<{ dem: PolarDem; done: number; total: number; ready: boolean } | null>(null);
  const firstSky = useRef(true);

  useEffect(() => {
    const v = new GroundView(hostRef.current!);
    setView(v);
    const off = v.onView(setState);
    return () => {
      off();
      v.dispose();
      setView(null);
    };
  }, []);

  useEffect(() => view?.setActive(active), [view, active]);
  useEffect(() => onHeading?.(state.azimuthDeg), [onHeading, state.azimuthDeg]);

  // High-resolution polar DEM: fetch the tiles around the site once, then use them.
  useEffect(() => {
    let stale = false;
    setPolar(null);
    loadPolar().then((dem) => {
      if (stale || !dem || !dem.covers(siteLat, siteLon)) return;
      setPolar({ dem, done: 0, total: 0, ready: false });
      dem
        .loadAround(siteLat, siteLon, POLAR_PLAN, (done, total) => !stale && setPolar({ dem, done, total, ready: false }))
        .then(() => !stale && setPolar((p) => (p ? { ...p, ready: true } : p)));
    });
    return () => {
      stale = true;
    };
  }, [siteLat, siteLon]);

  // Terrain: debounce rebuilds (each streamed band bumps demVersion; polar tiles arrive once).
  const polarReady = polar?.ready ? polar.dem : null;
  useEffect(() => {
    if (!view) return;
    const id = setTimeout(() => {
      const t = buildGroundTerrain(terrainSource(heightmap, polarReady), siteLat, siteLon, observerHeightM);
      view.setTerrain(t);
      setSiteElevationM(heightmap || polarReady ? t.siteElevationM : null);
    }, 150);
    return () => clearTimeout(id);
  }, [view, heightmap, polarReady, siteLat, siteLon, observerHeightM, demVersion]);

  useEffect(() => {
    if (!view) return;
    view.setSky(sky);
    // First sky: face the Sun (or the Earth if the Sun is well below the horizon).
    if (sky && firstSky.current) {
      firstSky.current = false;
      const target = sky.sun.elevationDeg > -5 ? sky.sun : sky.earth;
      view.look(target.azimuthDeg, Math.max(3, target.elevationDeg));
    }
  }, [view, sky]);

  const lookAt = (v?: AzEl) => v && view?.look(v.azimuthDeg, Math.max(2, v.elevationDeg));

  return (
    <div className="ground-view">
      <div ref={hostRef} className="ground-canvas" aria-label="View from the site" />
      <div className="ground-hud-top">
        <HeadingTape view={state} sun={sky?.sun} earth={sky?.earth} />
        <div className="ground-readout">
          View az {state.azimuthDeg.toFixed(0)}° · el {state.elevationDeg.toFixed(0)}° · FOV {state.hfovDeg.toFixed(0)}°
          {siteElevationM != null && ` · ground ${Math.round(siteElevationM).toLocaleString("en-US")} m, eye +${observerHeightM} m`}
        </div>
        <div className="ground-note">
          {polar?.ready ? (
            <>
              Terrain: LOLA 20 m polar DEM ({polar.dem.manifest.source}, {polar.dem.manifest.frame}) — 20 m to 6 km, 40 m to 25 km,
              80 m to 80 km, 160 m to 150 km — then {heightmap?.label ?? "—"} to 400 km, true scale with curvature
            </>
          ) : polar ? (
            <>Loading 20 m polar relief around the site: {polar.done}/{polar.total} tiles… (meanwhile {heightmap?.label ?? "—"}, ≈ 1.9 km/px)</>
          ) : (
            <>
              Terrain: LOLA {heightmap?.label ?? "—"} at true scale (≈ {heightmap ? heightmap.kmPerPixel.toFixed(1) : "—"} km/px, smoothed up
              close), out to 400 km with curvature
            </>
          )}{" "}
          · cast shadows (GPU, ±30 km around the line to the Sun) · uniform albedo, constant fill light (no earthshine model) ·
          dashed line = ideal horizon 0° · drag to look, wheel to zoom
        </div>
      </div>
      <div className="ground-buttons">
        <button type="button" onClick={() => lookAt(sky?.sun)} disabled={!sky}>
          Look at Sun
        </button>
        <button type="button" onClick={() => lookAt(sky?.earth)} disabled={!sky}>
          Look at Earth
        </button>
        <button type="button" onClick={onExit}>
          Back to orbit
        </button>
      </div>
    </div>
  );
}
