// "Landing sites" page: every past soft landing located in LROC NAC images (landingSites.json),
// with its coordinates, the nearest pole and a km-scale terrain summary from the LOLA display raster.

import { useEffect, useMemo, useRef, useState } from "react";

import { formatLat, formatLon } from "../lunar/geo";
import { Heightmap } from "../lunar/heightmap";
import { LANDING_SITES, LANDING_SOURCE, type LandingSite } from "../lunar/landingSites";
import { type BandManifest, DATA_BASE, loadHeightmap, loadJson, SETUP_HINT, streamBands } from "../lunar/loaders";
import { analyseTopography, colourRelief, fractionAtMost, POLE_BANDS, poleProximity, reliefGrid, type Topography } from "../lunar/siteTopography";

const DEM_BASE: string = (import.meta.env.VITE_LUNAR_DEM_BASE || DATA_BASE).replace(/\/?$/, "/");
const RADIUS_KM = 15; // statistics radius
const CROP_HALF_KM = 40; // shaded-relief thumbnail: 80 km across
const THUMB_PX = 112;

type DemState = { status: "loading"; progress: string } | { status: "ready"; hm: Heightmap } | { status: "missing"; reason: string };

/** ldem_16 bands covering the sites (±2° margin), else ldem_4.tif. */
async function loadSiteDem(onProgress: (s: string) => void): Promise<Heightmap> {
  try {
    const base = `${DEM_BASE}ldem_16/`;
    const m = await loadJson<BandManifest>(`${base}manifest.json`);
    const data = new Float32Array(m.width * m.height).fill(NaN);
    const rowOf = (lat: number) => Math.floor(((lat + 90) / 180) * m.height);
    const need = new Set<number>();
    for (const s of LANDING_SITES) {
      const [r0, r1] = [rowOf(Math.max(-90, s.lat - 2)), rowOf(Math.min(89.999, s.lat + 2))];
      m.bands.forEach((b, i) => b.row0 <= r1 && b.row0 + b.rows > r0 && need.add(i));
    }
    let done = 0;
    const order = [...need];
    const loaded = await streamBands(base, m, data, order, () => onProgress(`ldem_16: ${++done}/${order.length} bands`));
    if (loaded < order.length) throw new Error(`${order.length - loaded} ldem_16 bands failed`);
    return new Heightmap(data, m.width, m.height, "ldem_16");
  } catch (e) {
    console.warn("ldem_16 unavailable, falling back to ldem_4:", e);
    onProgress("ldem_4");
    return loadHeightmap(`${DEM_BASE}ldem_4.tif`, "ldem_4");
  }
}

type Sort = "date" | "south" | "north";

export function LandingSitesPage({ active, onShow }: { active: boolean; onShow: (s: LandingSite) => void }) {
  const [dem, setDem] = useState<DemState>({ status: "loading", progress: "" });
  const [sort, setSort] = useState<Sort>("date");
  const [hemi, setHemi] = useState<"all" | "south" | "north">("all");
  const [maxSlope, setMaxSlope] = useState(10); // same default as the globe's slope scope
  const started = useRef(false);

  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    loadSiteDem((p) => setDem({ status: "loading", progress: p }))
      .then((hm) => setDem({ status: "ready", hm }))
      .catch((e) => setDem({ status: "missing", reason: `${e instanceof Error ? e.message : e} — ${SETUP_HINT}` }));
  }, [active]);

  const rows = useMemo(() => {
    const list = LANDING_SITES.map((site) => ({ site, pole: poleProximity(site.lat) })).filter(
      (r) => hemi === "all" || r.pole.pole === hemi,
    );
    const toPole = (lat: number, p: "south" | "north") => (p === "south" ? lat + 90 : 90 - lat);
    if (sort === "date") list.sort((a, b) => a.site.date_utc.localeCompare(b.site.date_utc));
    else list.sort((a, b) => toPole(a.site.lat, sort) - toPole(b.site.lat, sort));
    return list;
  }, [sort, hemi]);

  const south = LANDING_SITES.filter((s) => s.lat <= 0).length;
  const polar = LANDING_SITES.filter((s) => poleProximity(s.lat).band === "polar").length;

  return (
    <div className="sites-page">
      <header className="sites-head">
        <h2>Past landing sites</h2>
        <p className="muted">
          {LANDING_SITES.length} soft landings located in LROC NAC images · {south} in the southern hemisphere,{" "}
          {LANDING_SITES.length - south} in the northern · {polar} polar (|lat| ≥ 80°).
        </p>
        <div className="sites-controls">
          <label>
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="date">Landing date</option>
              <option value="south">Closest to the south pole</option>
              <option value="north">Closest to the north pole</option>
            </select>
          </label>
          <label>
            Hemisphere
            <select value={hemi} onChange={(e) => setHemi(e.target.value as typeof hemi)}>
              <option value="all">Both</option>
              <option value="south">South</option>
              <option value="north">North</option>
            </select>
          </label>
          <label className="sites-slope">
            Max slope <output>{maxSlope.toFixed(1)}°</output>
            <input type="range" min={0.5} max={30} step={0.5} value={maxSlope} onChange={(e) => setMaxSlope(Number(e.target.value))} />
          </label>
          <span className="small sites-legend">
            <span className="slope-ok">■</span> ≤ {maxSlope.toFixed(1)}° · <span className="slope-bad">■</span> steeper ·{" "}
            <span className="muted">■</span> no data
          </span>
          <span className="muted small">
            {dem.status === "loading" && `Loading terrain… ${dem.progress}`}
            {dem.status === "ready" && `Terrain: ${dem.hm.label} (${dem.hm.kmPerPixel.toFixed(1)} km/px at the equator)`}
            {dem.status === "missing" && `Terrain unavailable: ${dem.reason}`}
          </span>
        </div>
      </header>

      <ul className="sites-list">
        {rows.map(({ site, pole }) => (
          <SiteCard key={site.id} site={site} pole={pole} hm={dem.status === "ready" ? dem.hm : null} maxSlope={maxSlope} onShow={onShow} />
        ))}
      </ul>

      <footer className="muted small sites-foot">
        <p>
          Coordinates: {LANDING_SOURCE.citation} (LROC table updated {LANDING_SOURCE.updated}). Planetocentric latitude,
          east-positive longitude, Mean Earth / Polar Axis. Spacecraft not yet located in NAC images (e.g. Luna 9, 13) are
          absent; impacts and rovers are excluded.
        </p>
        <p>
          Terrain: NASA LOLA via the SVS CGI Moon Kit raster, heights relative to the 1737.4 km sphere. Slopes are Horn 3×3 on
          a ~2 km grid (ldem_16) or ~7.6 km (ldem_4): a km-scale overview, much lower than 20 m or lander-footprint slopes.
          Relief and slope statistics cover cells within {RADIUS_KM} km of the site. Thumbnail colours: green where that
          km-scale slope is ≤ the chosen maximum, red where steeper (same convention as the globe's slope scope), so with
          the ~2 km baseline almost everything is green at lander-relevant thresholds — this does not mean the ground is
          smooth at lander scale. Shading uses a cartographic light from the
          north-west, not the real Sun. Pole classes: {POLE_BANDS.map((b) => b.label).join(", ")} — SELENE display thresholds.
          Visualization of the raster, not a science-service result; not a landing suitability assessment.
        </p>
      </footer>
    </div>
  );
}

const fmt = (v: number, d = 0, unit = "") => (Number.isFinite(v) ? `${v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d })}${unit}` : "—");

function SiteCard({
  site,
  pole,
  hm,
  maxSlope,
  onShow,
}: {
  site: LandingSite;
  pole: ReturnType<typeof poleProximity>;
  hm: Heightmap | null;
  maxSlope: number;
  onShow: (s: LandingSite) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const topo: Topography | null = useMemo(() => (hm ? analyseTopography(hm, site.lat, site.lon, RADIUS_KM) : null), [hm, site]);

  const grid = useMemo(() => (hm ? reliefGrid(hm, site.lat, site.lon, CROP_HALF_KM, THUMB_PX) : null), [hm, site]);
  const okFraction = topo ? fractionAtMost(topo.cellSlopesDeg, maxSlope) : NaN;

  useEffect(() => {
    const c = canvas.current?.getContext("2d");
    if (!c || !grid) return;
    const px = colourRelief(grid, maxSlope);
    c.putImageData(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, THUMB_PX, THUMB_PX), 0, 0);
  }, [grid, maxSlope]);

  const vehicle = site.vehicle && site.vehicle !== site.mission && !site.vehicle.includes(site.mission) ? site.vehicle : null;
  const bandLabel = POLE_BANDS.find((b) => b.band === pole.band)!.label;

  return (
    <li className="site-card">
      <figure className="site-thumb">
        <canvas ref={canvas} width={THUMB_PX} height={THUMB_PX} aria-label={`Shaded relief around ${site.mission}`} />
        <span className="site-marker" aria-hidden="true" />
        <figcaption className="muted small">N ↑ · {2 * CROP_HALF_KM} km across</figcaption>
      </figure>

      <div className="site-body">
        <h3>
          {site.mission}
          {vehicle && <span className="muted"> ({vehicle})</span>}
          {site.crewed && <span className="badge crewed">crewed</span>}
        </h3>
        <p className="muted small">Landed {site.date_utc}</p>

        <dl className="site-facts">
          <dt>Coordinates</dt>
          <dd>
            {formatLat(site.lat, 4)}, {formatLon(site.lon, site.lat, 4)}
            <span className="muted small"> ± {site.uncertainty_m} m · {site.coord_source}</span>
          </dd>
          <dt>Nearest pole</dt>
          <dd>
            <span className={`badge pole-${pole.band}`}>{pole.pole === "south" ? "South" : "North"} pole</span>{" "}
            {fmt(pole.distanceKm)} km · {bandLabel}
          </dd>
          <dt>Elevation</dt>
          <dd>{topo ? `${fmt(topo.elevationM, 0, " m")} (vs 1737.4 km sphere)` : "—"}</dd>
          <dt>Relief ({RADIUS_KM} km)</dt>
          <dd>{topo ? `${fmt(topo.reliefM, 0, " m")} (${fmt(topo.minM, 0)} to ${fmt(topo.maxM, 0)} m)` : "—"}</dd>
          <dt>Slope (km scale)</dt>
          <dd>
            {topo
              ? `site ${fmt(topo.slopeDeg, 1, "°")} · mean ${fmt(topo.meanSlopeDeg, 1, "°")} · max ${fmt(topo.maxSlopeDeg, 1, "°")}`
              : "—"}
          </dd>
          <dt>≤ {maxSlope.toFixed(1)}° ({RADIUS_KM} km)</dt>
          <dd>
            {Number.isFinite(okFraction) ? (
              <>
                <span className={okFraction === 1 ? "slope-ok" : okFraction >= 0.9 ? "" : "slope-bad"}>{fmt(okFraction * 100, 0, " %")}</span>
                <span className="muted small"> of km-scale cells</span>
              </>
            ) : (
              "—"
            )}
          </dd>
        </dl>
        <button type="button" className="link-btn" onClick={() => onShow(site)}>
          Show on globe →
        </button>
      </div>
    </li>
  );
}
