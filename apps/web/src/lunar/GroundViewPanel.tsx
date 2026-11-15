// "Standing on the site" view: overlay over the orbit globe, sharing the scenario time bar and the
// compass. Terrain rebuilt when the site, the observer height or the streamed DEM changes.

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";

import { normalizeLon, roundLon } from "./geo";
import { sunClearsTerrain } from "./groundAuto";
import { colorSourceFromImage } from "./groundColor";
import { buildGroundTerrain, DEFAULT_GROUND, type GroundTerrain, groundSignature, heightmapSource, horizonAt, ringSpacingPerMetre } from "./groundTerrain";
import { type GroundSky, GroundView, type GroundViewState } from "./groundView";
import type { Heightmap } from "./heightmap";
import { DATA_BASE, loadJson } from "./loaders";
import { type DemLayer, DemStack, PolarDem, type PolarManifest } from "./polarDem";
import { type AzEl, wrap360 } from "./skyGeometry";

// Optional high-resolution products (scripts/setup-polar-dem.sh): the south-polar 20 m pyramid and
// PGDA 5 m site DEMs listed in sites.json, opened once per page so tiles are fetched once.
const POLAR_BASE = `${DATA_BASE}polar_s/`;
const openDem = (base: string) => loadJson<PolarManifest>(`${base}manifest.json`).then((m) => new PolarDem(m, base));
let productsPromise: Promise<{ polar: PolarDem | null; sites: PolarDem[] }> | null = null;
const loadProducts = () =>
  (productsPromise ??= Promise.all([
    openDem(POLAR_BASE).catch(() => null),
    loadJson<{ sites: string[] }>(`${POLAR_BASE}sites.json`)
      .then((ix) => Promise.all(ix.sites.map((name) => openDem(`${POLAR_BASE}sites/${name}/`))))
      .catch(() => []),
  ]).then(([polar, sites]) => ({ polar, sites })));

/** Mesh sample spacing per metre of distance, and how far the 20 m pyramid is used. */
const SPACING = ringSpacingPerMetre(DEFAULT_GROUND);
const POLAR_MAX_M = 150_000;

/**
 * Products covering a site, finest first: the PGDA 5 m DEM only while it is finer than the mesh
 * spacing, then the 20 m pyramid (coarsest level kept) out to POLAR_MAX_M. null = none.
 */
function stackFor({ polar, sites }: { polar: PolarDem | null; sites: PolarDem[] }, lat: number, lon: number): DemStack | null {
  if (!polar?.covers(lat, lon)) return null;
  const layers: DemLayer[] = [];
  const site = sites.find((s) => s.covers(lat, lon));
  if (site) layers.push({ dem: site, maxDistanceM: (2 * site.manifest.levels.at(-1)!.scale_m) / SPACING, clamp: false });
  layers.push({ dem: polar, maxDistanceM: POLAR_MAX_M, clamp: true });
  return new DemStack(layers, SPACING);
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

const CARD = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** Heading tape: ticks over the horizontal field of view, Sun/Earth markers or edge arrows. */
function HeadingTape({ view, sun, earth }: { view: GroundViewState; sun?: AzEl; earth?: AzEl }) {
  const W = 560;
  const x = (az: number) => (normalizeLon(az - view.azimuthDeg) / view.hfovDeg + 0.5) * W;
  const ticks = [];
  const start = Math.floor((view.azimuthDeg - view.hfovDeg / 2) / 5) * 5;
  for (let a = start; a <= view.azimuthDeg + view.hfovDeg / 2; a += 5) {
    const az = wrap360(a);
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
    const d = normalizeLon(v.azimuthDeg - view.azimuthDeg);
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
  const [terrain, setTerrain] = useState<{ t: GroundTerrain; lat: number; lon: number } | null>(null);
  /** result of the last "Next sunlit time" search (null: none) */
  const [sunSearch, setSunSearch] = useState<string | null>(null);
  const [gps, setGps] = useState({ lat: String(siteLat), lon: String(siteLon) });
  useEffect(() => setGps({ lat: String(siteLat), lon: String(siteLon) }), [siteLat, siteLon]);
  const [fill, setFill] = useState(true);
  // An async failure (terrain build in a timer) is rethrown during render for GroundViewBoundary.
  const [error, setError] = useState<unknown>(null);
  /** high-resolution products around this site and their loading state; null: none here */
  const [dem, setDem] = useState<{ stack: DemStack; done: number; total: number; ready: boolean } | null>(null);
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

  // High-resolution products: fetch the tiles around the site, then use them.
  useEffect(() => {
    let stale = false;
    setDem(null);
    loadProducts().then((products) => {
      const stack = stale ? null : stackFor(products, siteLat, siteLon);
      if (!stack) return;
      setDem({ stack, done: 0, total: 0, ready: false });
      stack
        .loadAround(siteLat, siteLon, (done, total) => !stale && setDem({ stack, done, total, ready: false }))
        .then(() => !stale && setDem((d) => (d ? { ...d, ready: true } : d)));
    });
    return () => {
      stale = true;
    };
  }, [siteLat, siteLon]);

  // Terrain: debounce rebuilds (each streamed band bumps demVersion; polar tiles arrive once).
  const stack = dem?.ready ? dem.stack : null;
  const demSignature = useMemo(() => groundSignature(heightmap, siteLat, DEFAULT_GROUND.maxDistanceM), [heightmap, siteLat, demVersion]);
  useEffect(() => {
    if (!view) return;
    const id = setTimeout(() => {
      try {
        const global = heightmapSource(heightmap);
        const t = buildGroundTerrain(stack ? stack.source(global) : global, siteLat, siteLon, observerHeightM, DEFAULT_GROUND, colorSourceFromImage(colorImage));
        view.setTerrain(t);
        setTerrain({ t, lat: siteLat, lon: siteLon });
      } catch (e) {
        setError(e);
      }
    }, 150);
    return () => clearTimeout(id);
  }, [view, heightmap, colorImage, stack, siteLat, siteLon, observerHeightM, demSignature]);

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

  /** Terrain of the CURRENT site only (a rebuild is debounced after the site moves). */
  const current = terrain && terrain.lat === siteLat && terrain.lon === siteLon ? terrain.t : null;
  const siteElevationM = current && (heightmap || stack) ? current.siteElevationM : null;

  // A search belongs to one site: moving the site cancels it (and clears its message).
  const searchId = useRef(0);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    searchId.current++;
    setSearching(false);
    setSunSearch(null);
    return () => {
      searchId.current++;
    };
  }, [siteLat, siteLon]);

  /**
   * Moves the time bar to the next scenario time when the whole Sun clears the true terrain.
   * Times are evaluated in batches (concurrent requests once the sky comes from the backend) and
   * the loop yields a frame between batches, so a long scenario does not freeze the view.
   */
  const nextSunlit = async () => {
    if (!current || searching) return;
    const id = ++searchId.current;
    setSearching(true);
    setSunSearch(null);
    const step = Math.max(1, stepMinutes);
    const BATCH = 32;
    try {
      for (let m0 = Math.floor(tMin / step) * step + step; m0 <= spanMin; m0 += step * BATCH) {
        const times = Array.from({ length: BATCH }, (_, k) => m0 + k * step).filter((m) => m <= spanMin);
        const suns = await Promise.all(times.map((m) => sunAt(m, siteLat, siteLon)));
        if (id !== searchId.current) return; // site moved: stale search
        const hit = suns.findIndex((sun) => sunClearsTerrain(sun, current));
        if (hit >= 0) {
          setTime(times[hit]);
          return setSunSearch(`Sun clears the terrain at +${(times[hit] / 60).toFixed(1)} h`);
        }
        await new Promise(requestAnimationFrame);
      }
      setSunSearch("the Sun does not clear the terrain here for the rest of the scenario");
    } finally {
      if (id === searchId.current) setSearching(false);
    }
  };

  /** Go to a GPS point (planetocentric lat, east-positive lon in degrees). */
  const goGps = (e: FormEvent) => {
    e.preventDefault();
    const lat = Number(gps.lat);
    const lon = Number(gps.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) return;
    onMoveSite(+lat.toFixed(5), roundLon(normalizeLon(lon), 5));
  };

  /** "visible / hidden by terrain" from the rendered terrain's horizon in the body's direction. */
  const status = (name: string, v?: AzEl) => {
    if (!v) return null;
    if (!current) return `${name}: updating terrain…`;
    const h = horizonAt(current, v.azimuthDeg);
    const margin = v.elevationDeg - h;
    const verdict = margin > 0 ? `visible, ${margin.toFixed(1)}° above the terrain` : `hidden by terrain (${(-margin).toFixed(1)}° below it)`;
    return `${name} el ${v.elevationDeg.toFixed(1)}° · terrain horizon ${h.toFixed(1)}° at az ${v.azimuthDeg.toFixed(0)}° → ${verdict}`;
  };

  const lookAt = (v?: AzEl) => v && view?.look(v.azimuthDeg, Math.max(2, v.elevationDeg));

  if (error) throw error;
  const siteDem = dem && dem.stack.layers.length > 1 ? dem.stack.layers[0].dem : null;
  const polarDem = dem?.stack.layers.at(-1)?.dem;

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
      </div>
      <div className="ground-note">
        {dem?.ready && siteDem && <>LOLA 5 m site DEM ({siteDem.manifest.source}, PGDA) near the observer · then </>}
        {dem?.ready && polarDem ? (
          <>
            Terrain: LOLA 20 m polar DEM ({polarDem.manifest.source}, {polarDem.manifest.frame}) to{" "}
            {POLAR_MAX_M / 1000} km, each distance at the resolution matching the mesh spacing — then {heightmap?.label ?? "—"} to 400 km,
            true scale with curvature
          </>
        ) : dem ? (
          <>Loading {siteDem ? "5 m + 20 m" : "20 m"} polar relief around the site: {dem.done}/{dem.total} tiles… (meanwhile {heightmap?.label ?? "—"}, ≈ 1.9 km/px)</>
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
        <button type="button" onClick={nextSunlit} disabled={!current || !sky || searching}>
          {searching ? "Searching…" : "Next sunlit time"}
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
