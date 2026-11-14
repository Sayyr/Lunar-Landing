// "Standing on the site" view: overlay over the orbit globe, sharing the scenario time bar and the
// compass. Terrain rebuilt when the site, the observer height or the streamed DEM changes.

import { type FormEvent, useEffect, useRef, useState } from "react";

import { sunClearsTerrain } from "./groundAuto";
import { buildGroundTerrain, type ColorSource, DEFAULT_GROUND, type GroundTerrain, horizonAt, type TerrainSource } from "./groundTerrain";
import { type GroundSky, GroundView, type GroundViewState } from "./groundView";
import type { Heightmap } from "./heightmap";
import { DATA_BASE, loadJson } from "./loaders";
import { POLAR_PLAN, PolarDem, polarLevelFor, type PolarManifest, SITE_PLAN } from "./polarDem";
import type { AzEl } from "./skyGeometry";

// High-resolution south-polar DEM (scripts/setup-polar-dem.sh), shared by every ground view of the
// page so tiles are fetched once. null = not installed.
const POLAR_BASE = `${DATA_BASE}polar_s/`;
let polarPromise: Promise<PolarDem | null> | null = null;
const loadPolar = () =>
  (polarPromise ??= loadJson<PolarManifest>(`${POLAR_BASE}manifest.json`)
    .then((m) => new PolarDem(m, POLAR_BASE))
    .catch(() => null));

// PGDA 5 m site DEMs (same tile format and reader as the polar product), listed in sites.json.
let sitesPromise: Promise<PolarDem[]> | null = null;
const loadSites = () =>
  (sitesPromise ??= loadJson<{ sites: string[] }>(`${POLAR_BASE}sites.json`)
    .then((ix) =>
      Promise.all(ix.sites.map(async (name) => new PolarDem(await loadJson<PolarManifest>(`${POLAR_BASE}sites/${name}/manifest.json`), `${POLAR_BASE}sites/${name}/`))),
    )
    .catch(() => []));

/**
 * Finest data first, by distance from the observer: 5 m site DEM (if the site has one), 20 m polar
 * DEM pyramid, then the global raster. A product is skipped where it has no data.
 */
function terrainSource(hm: Heightmap | null, polar: PolarDem | null, site: PolarDem | null): TerrainSource {
  if (!polar && !site) return hm;
  const layers: [PolarDem, typeof POLAR_PLAN][] = [];
  if (site) layers.push([site, SITE_PLAN]);
  if (polar) layers.push([polar, POLAR_PLAN]);
  return (lat, lon, d) => {
    for (const [dem, plan] of layers) {
      const lv = polarLevelFor(d, plan);
      if (lv < 0) continue;
      const v = dem.sampleKm(lat, lon, lv);
      if (Number.isFinite(v)) return v * 1000;
    }
    return hm ? hm.sampleKmSmooth(lat, lon) * 1000 : 0;
  };
}

/**
 * Ground colour from the LROC WAC colour mosaic (real data, ≈ 2.7 km/px), normalised so its mean
 * brightness maps to a regolith grey: keeps the true large-scale albedo and tint variations.
 */
let colorCache: { img: HTMLImageElement; source: ColorSource } | null = null;
function colorSourceFrom(img: HTMLImageElement | null): ColorSource | undefined {
  if (!img) return undefined;
  if (colorCache?.img === img) return colorCache.source;
  const W = 2048;
  const H = 1024;
  const ctx = Object.assign(document.createElement("canvas"), { width: W, height: H }).getContext("2d", { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.drawImage(img, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;
  let mean = 0;
  for (let i = 0; i < px.length; i += 4) mean += px[i] + px[i + 1] + px[i + 2];
  mean /= (px.length / 4) * 3 * 255;
  const k = 0.62 / mean; // mean → 0.62 (linear-ish grey), relative brightness kept
  // The WAC colour product is contrast-enhanced: keep 35 % of its tint so the ground reads grey
  // with a faint real hue, as seen by eye.
  const SAT = 0.35;
  const source: ColorSource = (lat, lon) => {
    const x = Math.min(W - 1, Math.max(0, Math.floor(((lon + 180) / 360) * W)));
    const y = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
    const i = 4 * (y * W + x);
    const [r, g, b] = [(px[i] / 255) * k, (px[i + 1] / 255) * k, (px[i + 2] / 255) * k];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const c = (v: number) => Math.min(1, l + SAT * (v - l));
    return [c(r), c(g), c(b)];
  };
  colorCache = { img, source };
  return source;
}

interface Props {
  heightmap: Heightmap | null;
  /** LROC WAC colour mosaic (large-scale ground colour); null when not installed */
  colorImage: HTMLImageElement | null;
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
  /** Scenario time (minutes from start), its span and step, and a setter (stops playback). */
  tMin: number;
  spanMin: number;
  stepMinutes: number;
  setTime: (tMin: number) => void;
  /** Sun azimuth/elevation at a scenario time for a site (same source as the sky). */
  sunAt: (tMin: number, lat: number, lon: number) => Promise<AzEl>;
  /** Moves the scenario site (as a click on the globe would). */
  onMoveSite: (lat: number, lon: number) => void;
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

export function GroundViewPanel(props: Props) {
  const { heightmap, colorImage, siteLat, siteLon, observerHeightM, sky, demVersion, active, onExit, onHeading } = props;
  const { tMin, spanMin, stepMinutes, setTime, sunAt, onMoveSite } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<GroundView | null>(null);
  const [state, setState] = useState<GroundViewState>({ azimuthDeg: 0, elevationDeg: 5, hfovDeg: 90 });
  const [siteElevationM, setSiteElevationM] = useState<number | null>(null);
  const [terrain, setTerrain] = useState<{ t: GroundTerrain; lat: number; lon: number } | null>(null);
  /** null: idle; otherwise the "next sunlit time" search result to show */
  const [sunSearch, setSunSearch] = useState<string | null>(null);
  const [gps, setGps] = useState({ lat: String(siteLat), lon: String(siteLon) });
  useEffect(() => setGps({ lat: String(siteLat), lon: String(siteLon) }), [siteLat, siteLon]);
  const [fill, setFill] = useState(true);
  /** null: polar DEM not used here; otherwise its loading state for this site */
  const [polar, setPolar] = useState<{ dem: PolarDem; site: PolarDem | null; done: number; total: number; ready: boolean } | null>(null);
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
    Promise.all([loadPolar(), loadSites()]).then(([dem, sites]) => {
      if (stale || !dem || !dem.covers(siteLat, siteLon)) return;
      const site = sites.find((s) => s.covers(siteLat, siteLon)) ?? null;
      const progress = { polar: [0, 0], site: [0, 0] };
      const report = () => {
        if (stale) return;
        const done = progress.polar[0] + progress.site[0];
        setPolar({ dem, site, done, total: progress.polar[1] + progress.site[1], ready: false });
      };
      report();
      Promise.all([
        dem.loadAround(siteLat, siteLon, POLAR_PLAN, (d, t) => ((progress.polar = [d, t]), report())),
        site?.loadAround(siteLat, siteLon, SITE_PLAN, (d, t) => ((progress.site = [d, t]), report())),
      ]).then(() => !stale && setPolar((p) => (p ? { ...p, ready: true } : p)));
    });
    return () => {
      stale = true;
    };
  }, [siteLat, siteLon]);

  // Terrain: debounce rebuilds (each streamed band bumps demVersion; polar tiles arrive once).
  const polarReady = polar?.ready ? polar.dem : null;
  const siteReady = polar?.ready ? polar.site : null;
  useEffect(() => {
    if (!view) return;
    const id = setTimeout(() => {
      const t = buildGroundTerrain(terrainSource(heightmap, polarReady, siteReady), siteLat, siteLon, observerHeightM, DEFAULT_GROUND, colorSourceFrom(colorImage));
      view.setTerrain(t);
      setTerrain({ t, lat: siteLat, lon: siteLon });
      setSiteElevationM(heightmap || polarReady ? t.siteElevationM : null);
    }, 150);
    return () => clearTimeout(id);
  }, [view, heightmap, colorImage, polarReady, siteReady, siteLat, siteLon, observerHeightM, demVersion]);

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

  useEffect(() => view?.setFill(fill), [view, fill]);

  /** Move the time bar to the next scenario time when the whole Sun clears the true terrain. */
  const nextSunlit = async () => {
    if (!terrain) return;
    setSunSearch("searching…");
    const step = Math.max(1, stepMinutes);
    for (let m = Math.floor(tMin / step) * step + step; m <= spanMin; m += step) {
      if (sunClearsTerrain(await sunAt(m, siteLat, siteLon), terrain.t)) {
        setTime(m);
        return setSunSearch(`Sun clears the terrain at +${(m / 60).toFixed(1)} h`);
      }
    }
    setSunSearch("the Sun does not clear the terrain here for the rest of the scenario");
  };

  /** Go to a GPS point (planetocentric lat, east-positive lon in degrees). */
  const goGps = (e: FormEvent) => {
    e.preventDefault();
    const lat = Number(gps.lat);
    let lon = Number(gps.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) return;
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    setSunSearch(null);
    onMoveSite(+lat.toFixed(5), +lon.toFixed(5));
  };

  /** "visible / hidden by terrain" from the rendered terrain's horizon in the body's direction. */
  const status = (name: string, v?: AzEl) => {
    if (!v) return null;
    const h = terrain ? horizonAt(terrain.t, v.azimuthDeg) : 0;
    const margin = v.elevationDeg - h;
    const verdict = margin > 0 ? `visible, ${margin.toFixed(1)}° above the terrain` : `hidden by terrain (${(-margin).toFixed(1)}° below it)`;
    return `${name} el ${v.elevationDeg.toFixed(1)}° · terrain horizon ${h.toFixed(1)}° at az ${v.azimuthDeg.toFixed(0)}° → ${verdict}`;
  };

  const lookAt = (v?: AzEl) => v && view?.look(v.azimuthDeg, Math.max(2, v.elevationDeg));

  return (
    <div className="ground-view">
      <div ref={hostRef} className="ground-canvas" aria-label="View from the site" />
      <div className="ground-hud-top">
        <HeadingTape view={state} sun={sky?.sun} earth={sky?.earth} />
        <div className="ground-readout">
          Site {siteLat.toFixed(4)}°, {siteLon.toFixed(4)}° · view az {state.azimuthDeg.toFixed(0)}° · el {state.elevationDeg.toFixed(0)}° · FOV{" "}
          {state.hfovDeg.toFixed(0)}°
          {siteElevationM != null && ` · ground ${Math.round(siteElevationM).toLocaleString("en-US")} m, eye +${observerHeightM} m`}
        </div>
        {sunSearch && <div className="ground-auto">{sunSearch}</div>}
        {sky && terrain && (
          <div className="ground-visibility">
            <span className="sun">{status("Sun", sky.sun)}</span>
            <span className="earth">{status("Earth", sky.earth)}</span>
          </div>
        )}
        <div className="ground-note">
          {polar?.ready && polar.site && (
            <>
              LOLA 5 m site DEM ({polar.site.manifest.source}, PGDA) — 5 m to 3 km, 10 m to 8 km · then{" "}
            </>
          )}
          {polar?.ready ? (
            <>
              Terrain: LOLA 20 m polar DEM ({polar.dem.manifest.source}, {polar.dem.manifest.frame}) — 20 m to 6 km, 40 m to 25 km,
              80 m to 80 km, 160 m to 150 km — then {heightmap?.label ?? "—"} to 400 km, true scale with curvature
            </>
          ) : polar ? (
            <>Loading {polar.site ? "5 m + 20 m" : "20 m"} polar relief around the site: {polar.done}/{polar.total} tiles… (meanwhile {heightmap?.label ?? "—"}, ≈ 1.9 km/px)</>
          ) : (
            <>
              Terrain: LOLA {heightmap?.label ?? "—"} at true scale (≈ {heightmap ? heightmap.kmPerPixel.toFixed(1) : "—"} km/px, smoothed up
              close), out to 400 km with curvature
            </>
          )}{" "}
          · cast shadows (GPU, ±30 km around the line to the Sun) · colour:{" "}
          {colorImage ? "LROC WAC mosaic (≈ 2.7 km/px, real)" : "uniform"} × regolith grain, small craters, normal &amp; roughness maps
          (procedural, ILLUSTRATIVE — not data), metalness 0
          {fill ? " · fill light ON (visual aid, not physical)" : " · Sun light only"} · terrain horizon read from the rendered mesh
          (estimate, not the science computation) · dashed line = ideal horizon 0° · drag to look, wheel to zoom
        </div>
      </div>
      <div className="ground-buttons">
        <button type="button" onClick={() => lookAt(sky?.sun)} disabled={!sky}>
          Look at Sun
        </button>
        <button type="button" onClick={() => lookAt(sky?.earth)} disabled={!sky}>
          Look at Earth
        </button>
        <form className="ground-gps" onSubmit={goGps} aria-label="Go to a GPS point">
          <label>
            Lat <input type="number" step="any" min={-90} max={90} value={gps.lat} onChange={(e) => setGps({ ...gps, lat: e.target.value })} />
          </label>
          <label>
            Lon <input type="number" step="any" value={gps.lon} onChange={(e) => setGps({ ...gps, lon: e.target.value })} />
          </label>
          <button type="submit">Go</button>
        </form>
        <button type="button" onClick={nextSunlit} disabled={!terrain || !sky}>
          Next sunlit time
        </button>
        <button type="button" onClick={() => setFill((f) => !f)} aria-pressed={fill} title="Sky-like fill light so shadowed relief stays readable (not physical)">
          Fill light: {fill ? "on" : "off"}
        </button>
        <button type="button" onClick={onExit}>
          Back to orbit
        </button>
      </div>
    </div>
  );
}
