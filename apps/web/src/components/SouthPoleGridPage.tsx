// "South-pole grid" page: the 85°S–90°S LOLA 20 m slope screened on offset grids of 4 km discs
// (slopeGrid.ts). Each disc is coloured by the share of its 20 m pixels with slope ≤ the threshold.

import { useEffect, useMemo, useRef, useState } from "react";

import { MOON_RADIUS_KM } from "../lib/constants";
import { formatLat, formatLon } from "../lunar/geo";
import { type Disc, fractionAtMost, fractionColour, GRID_URL, loadSlopeGrid, rankDiscs, type SlopeGrid } from "../lunar/slopeGrid";

const GRID_NAMES = ["Grid 1", "Grid 2", "Grid 3", "Grid 4"];
// Local dev (downloads LDEM_85S_20M if missing, 920 MB, checksum-verified). Docker builds the grid into the web image.
const SETUP_CMD = "apps/web/scripts/setup-slope-grid.sh";

/** Map radius (km) of latitude lat (south polar stereographic, true at the pole). */
const rhoKm = (lat: number) => 2 * MOON_RADIUS_KM * Math.tan(((90 + lat) * Math.PI) / 360);
const pct = (f: number) => (Number.isFinite(f) ? `${(f * 100).toFixed(1)} %` : "—");

interface View {
  s: number; // px per km (CSS px)
  cx: number; // map km at the canvas centre
  cy: number;
}

export function SouthPoleGridPage({ active, onShow }: { active: boolean; onShow: (lat: number, lon: number) => void }) {
  const [grid, setGrid] = useState<SlopeGrid | null | undefined>(undefined);
  const [maxSlope, setMaxSlope] = useState(10);
  const [shown, setShown] = useState<boolean[]>([true, true, true, true]);
  const [selected, setSelected] = useState<Disc | null>(null);
  const [view, setView] = useState<View | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(640);
  const started = useRef(false);

  useEffect(() => {
    if (!active || started.current) return;
    started.current = true;
    void loadSlopeGrid().then(setGrid);
  }, [active]);

  // Square canvas following its container's width.
  useEffect(() => {
    const el = canvas.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize(Math.max(280, Math.min(900, Math.floor(el.clientWidth)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [grid]);

  const rhoMax = rhoKm(-85);
  const v: View = view ?? { s: size / (2 * rhoMax * 1.04), cx: 0, cy: 0 };
  const visible = useMemo(() => (grid ? grid.discs.filter((d) => shown[d.grid]) : []), [grid, shown]);
  const fractions = useMemo(() => {
    const f = new Float64Array(grid?.discs.length ?? 0);
    if (grid) for (const d of grid.discs) f[d.index] = fractionAtMost(d, maxSlope, grid.binDeg);
    return f;
  }, [grid, maxSlope]);
  const ranking = useMemo(() => (grid ? rankDiscs(visible, maxSlope, grid.binDeg, 15) : []), [grid, visible, maxSlope]);
  const summary = useMemo(() => {
    let ge90 = 0, ge99 = 0;
    for (const d of visible) {
      const f = fractions[d.index];
      if (f >= 0.9) ge90++;
      if (f >= 0.99) ge99++;
    }
    return { ge90, ge99 };
  }, [visible, fractions]);

  // Draw.
  useEffect(() => {
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx || !grid) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = size * dpr;
    cv.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const px = (x: number) => size / 2 + (x - v.cx) * v.s;
    const py = (y: number) => size / 2 - (y - v.cy) * v.s; // +y (toward lon 0) is up
    ctx.fillStyle = "#05070b";
    ctx.fillRect(0, 0, size, size);
    ctx.beginPath();
    ctx.arc(px(0), py(0), rhoMax * v.s, 0, 2 * Math.PI);
    ctx.fillStyle = "#11151d";
    ctx.fill();

    const r = (grid.diameterM / 2000) * v.s;
    const both = visible.some((d) => d.grid !== visible[0]?.grid);
    ctx.globalAlpha = both ? 0.75 : 0.95;
    for (const d of visible) {
      const x = px(d.x), y = py(d.y);
      if (x < -r || y < -r || x > size + r || y > size + r) continue;
      const [cr, cg, cb] = fractionColour(fractions[d.index]);
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.6, r), 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Latitude rings and meridian labels.
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.setLineDash([4, 4]);
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    for (const lat of [-89, -88, -87, -86, -85]) {
      ctx.beginPath();
      ctx.arc(px(0), py(0), rhoKm(lat) * v.s, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.fillText(`${-lat}°S`, px(0) + 3, py(rhoKm(lat)) - 3);
    }
    ctx.setLineDash([]);
    const edge = rhoMax * 1.02;
    ctx.textAlign = "center";
    ctx.fillText("0°", px(0), py(edge) - 2);
    ctx.fillText("180°", px(0), py(-edge) + 12);
    ctx.textAlign = "left";
    ctx.fillText("90°E", px(edge) + 3, py(0) + 4);
    ctx.textAlign = "right";
    ctx.fillText("90°W", px(-edge) - 3, py(0) + 4);
    ctx.textAlign = "left";

    if (selected) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px(selected.x), py(selected.y), Math.max(4, r + 1), 0, 2 * Math.PI);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }, [grid, visible, fractions, selected, size, v.s, v.cx, v.cy, rhoMax]);

  // Interaction: wheel zoom around the pointer, drag to pan, click to select.
  const drag = useRef<{ x: number; y: number; moved: boolean; v: View } | null>(null);
  const toMap = (e: { clientX: number; clientY: number }, vv: View) => {
    const b = canvas.current!.getBoundingClientRect();
    return { x: vv.cx + (e.clientX - b.left - size / 2) / vv.s, y: vv.cy - (e.clientY - b.top - size / 2) / vv.s };
  };
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((old) => {
        const cur = old ?? v;
        const k = Math.exp(-e.deltaY * 0.0015);
        const s = Math.min(400, Math.max(size / (2 * rhoMax * 1.1), cur.s * k));
        const m = toMap(e, cur);
        return { s, cx: m.x - (m.x - cur.cx) * (cur.s / s), cy: m.y - (m.y - cur.cy) * (cur.s / s) };
      });
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  });

  const pick = (e: React.PointerEvent) => {
    if (!grid) return;
    const m = toMap(e, v);
    const rKm = grid.diameterM / 2000;
    let best: Disc | null = null, bd = Infinity;
    for (const d of visible) {
      const dd = Math.hypot(d.x - m.x, d.y - m.y);
      if (dd < bd) [best, bd] = [d, dd];
    }
    setSelected(best && bd <= rKm ? best : null);
  };

  const focusDisc = (d: Disc) => {
    setSelected(d);
    setView({ s: Math.max(v.s, 12), cx: d.x, cy: d.y });
  };

  if (grid === undefined) return <div className="grid-page muted">{active ? "Loading the slope grid…" : null}</div>;
  if (grid === null)
    return (
      <div className="grid-page">
        <h2>South-pole slope grid</h2>
        <p className="warn">
          Grid file not installed ({GRID_URL}). It is derived offline from LDEM_85S_20M (see apps/web/scripts/POLAR_DATA.md). Local
          dev: run the script below. Docker: the web image builds it (apps/web/Dockerfile, stage "grid"); rebuild the image.
        </p>
        <pre className="small">{SETUP_CMD}</pre>
      </div>
    );

  const selF = selected ? fractions[selected.index] : NaN;
  return (
    <div className="grid-page">
      <header>
        <h2>South-pole slope grid</h2>
        <p className="muted">
          {grid.discs.length.toLocaleString("en-US")} discs of {grid.diameterM / 1000} km on {grid.grids.length} offset grids over{" "}
          {grid.file.source.product_id} (85°S–90°S, 20 m pixels). Grid 2 is shifted by half a step to cover the gaps of grid 1: together
          they cover the whole area.
        </p>
        <div className="sites-controls">
          <label className="sites-slope">
            Max slope <output>{maxSlope.toFixed(1)}°</output>
            <input type="range" min={0.5} max={30} step={grid.binDeg} value={maxSlope} onChange={(e) => setMaxSlope(Number(e.target.value))} />
          </label>
          {grid.grids.map((g) => (
            <label key={g} className="grid-toggle">
              <input type="checkbox" checked={shown[g]} onChange={(e) => setShown((s) => s.map((x, i) => (i === g ? e.target.checked : x)))} />
              {GRID_NAMES[g]} ({grid.file.method.grids[g].discs.toLocaleString("en-US")})
            </label>
          ))}
          <button type="button" className="link-btn" onClick={() => setView(null)}>
            Reset view
          </button>
        </div>
        <div className="grid-legend small">
          Share of 20 m pixels ≤ {maxSlope.toFixed(1)}°: <span className="grid-ramp" /> ≤ 50 % · 75 % · 100 % · {summary.ge90.toLocaleString("en-US")} discs
          ≥ 90 %, {summary.ge99.toLocaleString("en-US")} ≥ 99 %
        </div>
      </header>

      <div className="grid-layout">
        <div className="grid-canvas-wrap">
          <canvas
            ref={canvas}
            style={{ width: size, height: size }}
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, y: e.clientY, moved: false, v };
            }}
            onPointerMove={(e) => {
              const dr = drag.current;
              if (!dr) return;
              const dx = e.clientX - dr.x, dy = e.clientY - dr.y;
              if (Math.hypot(dx, dy) > 3) dr.moved = true;
              if (dr.moved) setView({ s: dr.v.s, cx: dr.v.cx - dx / dr.v.s, cy: dr.v.cy + dy / dr.v.s });
            }}
            onPointerUp={(e) => {
              if (drag.current && !drag.current.moved) pick(e);
              drag.current = null;
            }}
            aria-label="South polar map of slope discs"
          />
          <p className="muted small">North-up is the 0° meridian · wheel to zoom, drag to pan, click a disc.</p>
        </div>

        <aside className="grid-side">
          {selected ? (
            <div className="grid-detail">
              <h3>
                {GRID_NAMES[selected.grid]} · disc #{selected.index}
              </h3>
              <dl className="site-facts">
                <dt>Centre</dt>
                <dd>
                  {formatLat(selected.lat, 4)}, {formatLon(selected.lon, selected.lat, 4)}
                </dd>
                <dt>≤ {maxSlope.toFixed(1)}°</dt>
                <dd>{pct(selF)}</dd>
                <dt>Mean / max</dt>
                <dd>
                  {selected.meanDeg.toFixed(2)}° / {selected.maxDeg.toFixed(1)}°
                </dd>
                <dt>Pixels</dt>
                <dd>
                  {selected.validPx.toLocaleString("en-US")} valid{selected.nodataPx ? `, ${selected.nodataPx} no-data` : ""}
                </dd>
              </dl>
              <button type="button" className="link-btn" onClick={() => onShow(selected.lat, selected.lon)}>
                Show on globe (4 km slope disc) →
              </button>
            </div>
          ) : (
            <p className="muted small">Click a disc for its details.</p>
          )}

          <h3>Best discs ≤ {maxSlope.toFixed(1)}°</h3>
          <ol className="grid-rank">
            {ranking.map(({ disc, fraction }) => (
              <li key={disc.index}>
                <button type="button" className={`link-btn${selected?.index === disc.index ? " active" : ""}`} onClick={() => focusDisc(disc)}>
                  {pct(fraction)} · {formatLat(disc.lat, 2)}, {formatLon(disc.lon, disc.lat, 2)}
                </button>
                <span className="muted small">
                  {" "}
                  mean {disc.meanDeg.toFixed(1)}° · max {disc.maxDeg.toFixed(0)}° · {GRID_NAMES[disc.grid]}
                </span>
              </li>
            ))}
          </ol>
        </aside>
      </div>

      <footer className="muted small sites-foot">
        <p>
          Slope: Horn 3×3 on the native 20 m LOLA grid (same code as the slope tiles and the server check,
          services/science/src/slope_core.hpp), histogram per disc in {grid.binDeg}° bins, so the share is exact for the slider steps. Disc
          radius is a ground distance on the 1737.4 km sphere; only discs entirely inside 85°S are listed. Ranking: highest share, then
          lowest mean slope. {grid.file.scale_warning} Illumination, Earth visibility and hazards are not part of this score.
        </p>
      </footer>
    </div>
  );
}
