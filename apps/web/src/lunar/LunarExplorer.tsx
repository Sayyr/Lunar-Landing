// Interactive Moon explorer (ported from apps/moon-explorer/js/main.js + index.html):
// LOLA relief, LROC colour, IAU feature names, hover read-out, search, markers.
// A click also selects the scenario site (onPick).
//
// Public DOM events (bubbling, emitted on the explorer root):
//   'moonhover' and 'moonclick', detail = { lat, lon, altM, feature }
//   feature = null | { name, type, diameterKm, lat, lon, distanceKm }

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getCelestialState } from "../api/celestial";
import { ScaleBar } from "../components/ScaleBar";
import { DATA_README_URL } from "../lib/links";

import { type Feature, FeatureIndex, type FeaturesJson, type PublicFeature, publicFeature } from "./features";
import { formatAltM, formatLat, formatLon, roundLon } from "./geo";
import { Globe } from "./globe";
import { Heightmap } from "./heightmap";
import { type BandManifest, bandOrderNear, DATA_BASE, loadHeightmap, loadImage, loadJson, type Progress, SETUP_HINT, streamBands } from "./loaders";
import { GroundViewBoundary } from "./GroundViewBoundary";
import { GroundViewPanel } from "./GroundViewPanel";
import { SlopeMap } from "./SlopeMap";
import { type ScopeInfo, type SlopeProductInfo, SlopeScope } from "./slopeOverlay";
import { loadSlopeProduct } from "./slopeProduct";
import { LANDING_SITES, LANDING_SOURCE, landingLabel, nearestLandingSite, type LandingSite } from "./landingSites";
import { SkyCompass } from "./SkyCompass";
import { TREK_LAYER } from "./tileScheme";
import type { TileStatus } from "./tileLayer";
import { type AzEl, earthToEnu, eclToEnu, localAzEl, type MoonSky, moonSky } from "./skyGeometry";

// Base URL of the elevation rasters: point it at R2/a CDN (CORS required) if ldem_16 exceeds the
// host's file-size limit (25 MiB on Cloudflare Pages).
const DEM_BASE: string = (import.meta.env.VITE_LUNAR_DEM_BASE || DATA_BASE).replace(/\/?$/, "/");

export interface MoonPointInfo {
  lat: number;
  lon: number;
  altM: number | null;
  feature: PublicFeature | null;
  /** Past landing site under the pointer (within a few screen pixels), if any. */
  landing?: { site: LandingSite; distanceKm: number } | null;
}

type Dem = "4" | "16";

/** Diameter of the slope scope disc on the globe, km (fixed, independent of the zoom). */
const SLOPE_DISC_DIAMETER_KM = 4;

const isMobile = () => matchMedia("(pointer: coarse)").matches || Math.min(screen.width, screen.height) < 700;

/**
 * ?dem=4 or ?dem=16 forces the raster; otherwise ldem_4 on mobile / small screens, ldem_16 elsewhere.
 * Cached: the GPU probe creates a throwaway WebGL context.
 */
let demChoice: { dem: Dem | null; notes: string[] } | null = null;
function chooseDem(): { dem: Dem | null; notes: string[] } {
  if (demChoice) return demChoice;
  const notes: string[] = [];
  const forced = new URLSearchParams(location.search).get("dem");
  let dem: Dem = forced === "4" || forced === "16" ? forced : isMobile() ? "4" : "16";
  const probe = document.createElement("canvas").getContext("webgl2");
  if (!probe) return (demChoice = { dem: null, notes });
  const maxTex = probe.getParameter(probe.MAX_TEXTURE_SIZE) as number;
  probe.getExtension("WEBGL_lose_context")?.loseContext();
  // ldem_16 is 5760 px wide: impossible if the GPU caps textures at 4096.
  if (dem === "16" && maxTex < 5760) {
    notes.push(`Max texture ${maxTex} px: ldem_16 (5760 px) unsupported, using ldem_4.`);
    dem = "4";
  }
  return (demChoice = { dem, notes });
}

// Data is loaded once per page and shared across remounts (React StrictMode, hot reload):
// one CPU copy of the raster, as in moon-explorer.
interface LunarData {
  colorImage: HTMLImageElement | null;
  heightmap: Heightmap | null;
  features: FeaturesJson | null;
  notes: string[];
}
let dataPromise: Promise<LunarData> | null = null;
const progressListeners = new Set<(pct: number | null) => void>();

// ldem_16 split into latitude bands (scripts/split_ldem.py): the globe starts on ldem_4 resampled
// to the ldem_16 grid, and each band overwrites its rows in place as it arrives (nearest to the
// site first). Shared by every globe instance of the page, like the data above.
export interface DemStreamState {
  loaded: number;
  total: number;
  done: boolean;
}
let demStream: DemStreamState | null = null;
const bandListeners = new Set<(row0: number, rows: number) => void>();
const streamListeners = new Set<(s: DemStreamState) => void>();

async function loadElevation(dem: Dem, notes: string[], siteLat: number, progress: Progress): Promise<Heightmap | null> {
  if (dem === "16") {
    const base = `${DEM_BASE}ldem_16/`;
    const manifest = await loadJson<BandManifest>(`${base}manifest.json`).catch(() => null);
    if (manifest) {
      const coarse = await loadHeightmap(`${DEM_BASE}ldem_4.tif`, "ldem_4", progress);
      const hm = new Heightmap(coarse.resampled(manifest.width, manifest.height), manifest.width, manifest.height, "ldem_16 (streaming)");
      const state: DemStreamState = { loaded: 0, total: manifest.bands.length, done: false };
      demStream = state;
      void streamBands(base, manifest, hm.data, bandOrderNear(manifest, siteLat), (row0, rows) => {
        state.loaded++;
        hm.extendRange(row0, rows);
        bandListeners.forEach((l) => l(row0, rows));
        streamListeners.forEach((l) => l({ ...state }));
      }).catch((e) => (console.warn("ldem_16 streaming failed:", e), 0)).then((n) => {
        state.done = true;
        if (n === state.total) hm.label = "ldem_16";
        else notes.push(`ldem_16: ${state.total - n} of ${state.total} bands failed; those latitudes stay at ldem_4 resolution.`);
        streamListeners.forEach((l) => l({ ...state }));
      });
      return hm;
    }
  }
  // Single-file path: ldem_4, or ldem_16 when it was not split.
  return loadHeightmap(`${DEM_BASE}ldem_${dem}.tif`, `ldem_${dem}`, progress)
    // `setup-data.sh --light` installs ldem_4 only: fall back to it rather than a flat Moon.
    .catch((e: Error) => {
      if (dem !== "16") throw e;
      notes.push(`ldem_16 unavailable (${e.message}): using ldem_4.`);
      return loadHeightmap(`${DEM_BASE}ldem_4.tif`, "ldem_4", progress);
    })
    .catch((e: Error) => {
      notes.push(`Elevation raster unavailable (${e.message}): flat sphere, no altitude — ${SETUP_HINT}.`);
      return null;
    });
}

function loadLunarData(dem: Dem, notes: string[], siteLat: number): Promise<LunarData> {
  if (dataPromise) return dataPromise;
  const parts = { color: 0, dem: 0, names: 0 };
  const weights = { color: 0.25, dem: 0.65, names: 0.1 };
  let lastPct: number | null = -1;
  const progress = (key: keyof typeof parts): Progress => (f) => {
    parts[key] = f ?? parts[key];
    const total = (Object.keys(parts) as (keyof typeof parts)[]).reduce((s, k) => s + parts[k] * weights[k], 0);
    // One notification per whole percent, not per network chunk (thousands for ldem_16).
    const pct = f == null ? null : Math.round(total * 100);
    if (pct === lastPct) return;
    lastPct = pct;
    progressListeners.forEach((l) => l(pct == null ? null : pct / 100));
  };
  dataPromise = Promise.all([
    loadImage(`${DATA_BASE}moon_color.jpg`, progress("color")).catch((e: Error) => {
      notes.push(`Colour mosaic unavailable (${e.message}): untextured sphere — ${SETUP_HINT}.`);
      return null;
    }),
    loadElevation(dem, notes, siteLat, progress("dem")),
    loadJson<FeaturesJson>(`${DATA_BASE}features.json`, progress("names")).catch((e: Error) => {
      notes.push(`Feature names unavailable (${e.message}) — ${SETUP_HINT}.`);
      return null;
    }),
  ]).then(([colorImage, heightmap, features]) => ({ colorImage, heightmap, features, notes }));
  return dataPromise;
}

/** Read-out text shared by the last-click panel (JSX) and the hover tooltip (DOM). */
function infoText(info: MoonPointInfo) {
  const f = info.feature;
  return {
    coords: `${formatLat(info.lat)}   ${formatLon(info.lon, info.lat)}`,
    elevation: `Elevation ${formatAltM(info.altM)}`,
    feature: f ? f.name : "No named feature",
    detail: f ? `${f.type} · ${f.distanceKm.toFixed(0)} km from centre` : null,
    landing: info.landing
      ? `Landing site: ${landingLabel(info.landing.site)} (±${info.landing.site.uncertainty_m} m, LROC)`
      : null,
  };
}

function InfoLines({ info }: { info: MoonPointInfo }) {
  const t = infoText(info);
  return (
    <>
      <div style={{ whiteSpace: "pre" }}>{t.coords}</div>
      <div>{t.elevation}</div>
      <div className={t.detail ? "feat" : "feat none"}>
        {t.feature} {t.detail && <small>{t.detail}</small>}
      </div>
      {t.landing && <div className="feat landing">{t.landing}</div>}
    </>
  );
}

/** Tooltip content built with textContent (no innerHTML, no React render) — hover runs every frame. */
function fillTooltip(el: HTMLElement, info: MoonPointInfo) {
  const t = infoText(info);
  const line = (text: string, cls?: string) => {
    const d = document.createElement("div");
    d.textContent = text;
    if (cls) d.className = cls;
    return d;
  };
  const featEl = line(t.feature, t.detail ? "feat" : "feat none");
  if (t.detail) featEl.append(Object.assign(document.createElement("small"), { textContent: t.detail }));
  el.replaceChildren(line(t.coords), line(t.elevation), featEl, ...(t.landing ? [line(t.landing, "feat landing")] : []));
}

function placeTooltip(tip: HTMLElement, x: number, y: number) {
  const pad = 16;
  const r = tip.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + r.width > innerWidth - 8) left = x - r.width - pad;
  if (top + r.height > innerHeight - 8) top = y - r.height - pad;
  tip.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
}

interface Props {
  /** false while the tab is hidden: the render loop is paused. */
  active: boolean;
  siteLat: number;
  siteLon: number;
  /** Called when the user clicks (long-press on touch) a surface point. */
  onPick: (lat: number, lon: number) => void;
  focus?: { lat: number; lon: number; seq: number } | null;
  /** Eye height above the ground for the ground view (scenario observer_height_m). */
  observerHeightM: number;
  /** Scenario time range: the sky (Sun, Earth, compass) can be scrubbed across it. */
  startUtc: string;
  durationHours: number;
  stepMinutes: number;
  /** Rendered at the top of the "⋯" panel (scenario form, results). */
  children?: ReactNode;
}

const PLAY_SECONDS = 20;
const LEFT_OVERLAY_PX = 20 + 250 + 20;
const RIGHT_BUTTONS_PX = 130;
const PANEL_PX = 380;

export function LunarExplorer({ active, siteLat, siteLon, onPick, focus, startUtc, durationHours, stepMinutes, observerHeightM, children }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const onPickRef = useRef(onPick);
  const siteRef = useRef({ lat: siteLat, lon: siteLon });
  const mobile = useMemo(isMobile, []);

  const [globe, setGlobe] = useState<Globe | null>(null);
  const [index, setIndex] = useState<FeatureIndex | null>(null);
  const [loadPct, setLoadPct] = useState<number | null>(0);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [dataset, setDataset] = useState("");
  const [demStreamState, setDemStream] = useState<DemStreamState | null>(null);
  const [heightmap, setHeightmap] = useState<Heightmap | null>(null);
  const [colorImage, setColorImage] = useState<HTMLImageElement | null>(null);
  const [demVersion, setDemVersion] = useState(0);
  const [skyBody, setSkyBody] = useState<MoonSky | null>(null);
  const [groundOn, setGroundOn] = useState(false);
  const [demLabel, setDemLabel] = useState<Dem>("4");
  const [exag, setExag] = useState(2);
  const [grid, setGrid] = useState(false);
  const [refine, setRefine] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false); // opened from the "⋯" button
  const [lastClick, setLastClick] = useState<MoonPointInfo | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Feature | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy lat, lon");
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  // Sky time = offset in minutes from the scenario start.
  const [tMin, setTMin] = useState(0);
  const [mode, setMode] = useState<"live" | "playing" | "paused">("live");
  const [sky, setSky] = useState<{ sun: AzEl; earth: AzEl } | null>(null);
  const [skyError, setSkyError] = useState<string | null>(null);
  const diskRef = useRef<HTMLDivElement>(null);
  const sunPtrRef = useRef<HTMLDivElement>(null);
  const earthPtrRef = useRef<HTMLDivElement>(null);
  const [kmPerPx, setKmPerPx] = useState<number | null>(null);
  const [tilesOn, setTilesOn] = useState(true);
  const [slopeOn, setSlopeOn] = useState(false);
  const [slopeMax, setSlopeMax] = useState(10);
  const [slopeState, setSlopeState] = useState<
    | { kind: "off" }
    | { kind: "loading" }
    | { kind: "ready"; info: SlopeProductInfo | null; scope: ScopeInfo | null }
  >({ kind: "off" });
  const [slopeProgress, setSlopeProgress] = useState<{ done: number; total: number } | null>(null);
  const slopeLayer = useRef<{ overlay: SlopeScope; remove: () => void } | null>(null);
  const [tileStatus, setTileStatus] = useState<TileStatus>("loading");

  useEffect(() => {
    onPickRef.current = onPick;
    siteRef.current = { lat: siteLat, lon: siteLon };
  });

  // --- Boot: load data once, build the globe, wire pointer interactions ---------------------
  useEffect(() => {
    const host = hostRef.current!;
    const root = rootRef.current!;
    const tip = tipRef.current!;
    let cancelled = false;
    let g: Globe | null = null;
    let detach = () => {};

    const { dem, notes: demNotes } = chooseDem();
    const notesAcc = [...demNotes];
    if (!dem) {
      setFatal("WebGL 2 is not available in this browser.");
      return;
    }
    setDemLabel(dem);
    const onProgress = (p: number | null) => !cancelled && setLoadPct(p);
    progressListeners.add(onProgress);

    loadLunarData(dem, notesAcc, siteRef.current.lat)
      .then((data) => {
        if (cancelled) return;
        const site = siteRef.current;
        g = new Globe(host, {
          colorImage: data.colorImage,
          heightmap: data.heightmap,
          segments: mobile ? 512 : 1024,
          initialView: site,
        });
        const idx = new FeatureIndex(data.features ?? { types: {}, features: [] });
        const allNotes = [...new Set([...notesAcc, ...data.notes])];
        if (data.heightmap && !g.floatLinear) allNotes.push("float32 linear filtering unavailable: relief sampled with 'nearest'.");
        const hm = data.heightmap;
        setHeightmap(hm);
        setColorImage(data.colorImage);
        if (hm) setDemLabel(hm.width >= 5760 ? "16" : "4");
        setDataset(
          (hm ? `${hm.label} · ${hm.width}×${hm.height} px · ≈ ${hm.kmPerPixel.toFixed(1)} km/px at the equator` : "no elevation raster") +
            ` · ${idx.features.length} features`,
        );
        setNotes(allNotes);
        setIndex(idx);
        g.setLandingSites(LANDING_SITES);
        setGlobe(g);
        const detachPointer = attachPointer(g, idx, root, tip);
        // Streamed ldem_16 bands: upload each one to this globe's GPU texture as it arrives.
        const gl = g;
        const onBand = (row0: number, rows: number) => {
          gl.applyHeightBand(row0, rows);
          setDemVersion((v) => v + 1);
        };
        bandListeners.add(onBand);
        streamListeners.add(setDemStream);
        if (demStream) setDemStream({ ...demStream });
        detach = () => {
          detachPointer();
          bandListeners.delete(onBand);
          streamListeners.delete(setDemStream);
        };
      })
      .catch((e: Error) => !cancelled && setFatal(`Loading failed: ${e.message}`));

    function attachPointer(gl: Globe, idx: FeatureIndex, rootEl: HTMLElement, tipEl: HTMLElement) {
      const canvas = gl.renderer.domElement;

      const describe = (x: number, y: number): MoonPointInfo | null => {
        const hit = gl.pick(x, y);
        if (!hit) return null;
        // Landing points are drawn 9 px wide: match within ~8 px (scale at the view centre).
        const landing = nearestLandingSite(hit.lat, hit.lon, Math.max(0.5, 8 * gl.kmPerPixelAtCentre()));
        return { ...hit, feature: publicFeature(idx.nearest(hit.lat, hit.lon)), landing };
      };
      const hover = (x: number, y: number) => {
        const info = describe(x, y);
        if (!info) {
          tipEl.hidden = true;
          return;
        }
        fillTooltip(tipEl, info);
        tipEl.hidden = false;
        placeTooltip(tipEl, x, y);
        rootEl.dispatchEvent(new CustomEvent("moonhover", { detail: info, bubbles: true }));
      };
      const click = (x: number, y: number) => {
        const info = describe(x, y);
        if (!info) return;
        gl.addMarker(info.lat, info.lon);
        setLastClick(info);
        // Re-wrap after rounding: 179.99996 would round to 180, outside the API's [-180, 180).
        onPickRef.current(+info.lat.toFixed(4), roundLon(info.lon, 4));
        rootEl.dispatchEvent(new CustomEvent("moonclick", { detail: info, bubbles: true }));
      };

      // Hover throttled to one pick per animation frame.
      let pending: { x: number; y: number } | null = null;
      let scheduled = false;
      const queueHover = (x: number, y: number) => {
        pending = { x, y };
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          if (pending) hover(pending.x, pending.y);
        });
      };

      // Mouse: continuous hover; click = press/release without dragging.
      // Touch: tap = hover (tooltip); long press (≥ 550 ms) = click (marker).
      let down: { x: number; y: number; moved: boolean; type: string; long: boolean } | null = null;
      let longTimer = 0;
      const onMove = (e: PointerEvent) => {
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) {
          down.moved = true;
          clearTimeout(longTimer);
        }
        if (e.pointerType === "mouse") queueHover(e.clientX, e.clientY);
      };
      const onDown = (e: PointerEvent) => {
        down = { x: e.clientX, y: e.clientY, moved: false, type: e.pointerType, long: false };
        if (e.pointerType !== "mouse") {
          longTimer = window.setTimeout(() => {
            if (down && !down.moved) {
              down.long = true;
              click(down.x, down.y);
              navigator.vibrate?.(15);
            }
          }, 550);
        }
      };
      const onUp = (e: PointerEvent) => {
        clearTimeout(longTimer);
        if (!down || down.moved) {
          down = null;
          return;
        }
        if (down.type === "mouse") click(e.clientX, e.clientY);
        else if (!down.long) hover(e.clientX, e.clientY);
        down = null;
      };
      const onLeave = (e: PointerEvent) => {
        if (e.pointerType === "mouse") tipEl.hidden = true;
      };
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerdown", onDown);
      canvas.addEventListener("pointerup", onUp);
      canvas.addEventListener("pointerleave", onLeave);
      const onDblClick = (e: MouseEvent) => {
        const body = gl.bodyAt(e.clientX, e.clientY);
        if (body && !gl.pick(e.clientX, e.clientY)) gl.viewBody(body);
      };
      canvas.addEventListener("dblclick", onDblClick);
      return () => {
        clearTimeout(longTimer);
        pending = null;
        canvas.removeEventListener("pointermove", onMove);
        canvas.removeEventListener("pointerdown", onDown);
        canvas.removeEventListener("pointerup", onUp);
        canvas.removeEventListener("pointerleave", onLeave);
        canvas.removeEventListener("dblclick", onDblClick);
        tipEl.hidden = true;
      };
    }

    return () => {
      cancelled = true;
      progressListeners.delete(onProgress);
      detach();
      g?.dispose();
      setGlobe(null);
    };
  }, [mobile]);

  // --- Settings → globe ---------------------------------------------------------------------
  useEffect(() => globe?.setExaggeration(exag), [globe, exag]);
  useEffect(() => globe?.setGridVisible(grid), [globe, grid]);
  useEffect(() => {
    if (globe) globe.refinePick = refine;
  }, [globe, refine]);
  useEffect(() => globe?.setSite(siteLat, siteLon), [globe, siteLat, siteLon]);
  useEffect(() => {
    if (!globe) return;
    const mobile = window.innerWidth < 640;
    globe.setFreeArea(mobile ? 0 : LEFT_OVERLAY_PX, mobile ? 0 : RIGHT_BUTTONS_PX + (panelOpen ? PANEL_PX : 0));
  }, [globe, panelOpen]);
  useEffect(() => {
    if (focus) globe?.flyTo(focus.lat, focus.lon, 50, true);
  }, [globe, focus]);

  // Slope scope draped on the globe, centred on the selected site: the shared slope product is
  // opened the first time the filter is switched on; the disc (fixed 4 km diameter) is rebuilt when
  // the site changes; the threshold is a shader uniform.
  useEffect(() => {
    if (!globe || !slopeOn || slopeLayer.current) return;
    let stale = false;
    setSlopeState({ kind: "loading" });
    void loadSlopeProduct().then((product) => {
      if (stale) return;
      const overlay = new SlopeScope(product, globe.heightTexture);
      slopeLayer.current = { overlay, remove: globe.addSurfaceOverlay(overlay) };
      overlay.setMaxSlope(slopeMax);
      setSlopeState({ kind: "ready", info: overlay.info, scope: null });
    });
    return () => {
      stale = true;
    };
    // slopeMax is applied by its own effect; reloading on every slider move would defeat the point
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globe, slopeOn]);
  const slopeReady = slopeState.kind === "ready";
  useEffect(() => {
    const layer = slopeLayer.current;
    if (!globe || !layer || !slopeReady || !slopeOn) return;
    // Disc of fixed size (SLOPE_DISC_DIAMETER_KM) centred on the selected site, independent of the
    // zoom: rebuilt only when the site, the relief or the layer changes.
    void layer.overlay
      .update(siteLat, siteLon, SLOPE_DISC_DIAMETER_KM / 2, heightmap, (done, total) => total > 0 && done < total && setSlopeProgress({ done, total }))
      .then((scope) => {
        setSlopeProgress(null);
        if (scope) setSlopeState((s) => (s.kind === "ready" ? { ...s, scope } : s));
      });
    return () => {
      // Switching off (or moving the site) mid-load: a pending update must not re-show the disc.
      layer.overlay.cancel();
    };
  }, [globe, slopeOn, slopeReady, siteLat, siteLon, heightmap]);
  useEffect(() => slopeLayer.current?.overlay.setMaxSlope(slopeMax), [slopeMax, slopeReady]);
  // A new globe (relief quality change) starts without the layer.
  useEffect(
    () => () => {
      slopeLayer.current?.remove();
      slopeLayer.current = null;
    },
    [globe],
  );
  // The orbit globe pauses while the ground view covers it.
  useEffect(() => globe?.setActive(active && !groundOn), [globe, active, groundOn]);
  useEffect(() => globe?.setTilesEnabled(tilesOn), [globe, tilesOn]);
  useEffect(() => globe?.onTileStatus(setTileStatus), [globe]);

  // --- Sky: Sun/Earth for the scenario time -----------------------------------------------------
  const startMs = Date.parse(startUtc);
  const spanMin = Math.max(0, durationHours * 60);
  useEffect(() => setTMin((t) => Math.min(t, spanMin)), [spanMin]);

  useEffect(() => {
    if (!globe || Number.isNaN(startMs)) return;
    let stale = false;
    getCelestialState(new Date(startMs + tMin * 60_000)).then(
      (state) => {
        if (stale) return;
        const s = moonSky(state);
        setSkyBody(s);
        globe.setSky(s);
        setSky({ sun: localAzEl(s.sun, siteLat, siteLon), earth: localAzEl(s.earth, siteLat, siteLon) });
        setSkyError(null);
      },
      (e) => {
        if (stale) return;
        // No sky from another instant: compass, Sun/Earth readouts and ground-view sky are hidden (the globe
        // keeps its last lighting, which is display only); the footnote says why.
        setSky(null);
        setSkyBody(null);
        setSkyError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      stale = true;
    };
  }, [globe, startMs, tMin, siteLat, siteLon]);

  useEffect(() => {
    if (mode !== "live" || !active || Number.isNaN(startMs)) return;
    const tick = () => {
      const t = (Date.now() - startMs) / 60_000;
      setTMin(Math.min(Math.max(t, 0), spanMin));
      if (t < 0 || t > spanMin) setMode("paused");
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [mode, active, startMs, spanMin]);

  useEffect(() => {
    if (mode !== "playing" || !active || spanMin === 0) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last) / 1000 / PLAY_SECONDS) * spanMin;
      last = now;
      setTMin((t) => (t + dt >= spanMin ? 0 : t + dt)); // loop
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode, active, spanMin]);

  // Same flat compass in both views (no CSS 3D re-render): here N points to the on-screen north at
  // the site; in the ground view the top is where the observer looks (onGroundHeading).
  const hasSky = sky !== null;
  useEffect(() => {
    if (!globe || !hasSky || groundOn) return;
    const update = () => {
      const el = diskRef.current;
      if (!el) return;
      const a = globe.northScreenAngle(siteLat, siteLon);
      el.style.transform = `rotate(${(a ?? 0).toFixed(1)}deg)`;
      el.style.opacity = a == null ? "0.45" : "1"; // dimmed: site behind the camera plane
    };
    update();
    return globe.onCameraChange(update);
  }, [globe, hasSky, siteLat, siteLon, groundOn]);

  const setGroundTime = useCallback((m: number) => {
    setMode("paused");
    setTMin(m);
  }, []);
  const sunAt = useCallback(
    async (m: number, lat: number, lon: number) =>
      localAzEl(moonSky(await getCelestialState(new Date(startMs + m * 60_000))).sun, lat, lon),
    [startMs],
  );
  const moveSite = useCallback((lat: number, lon: number) => onPickRef.current(lat, lon), []);

  /** Ground view: flat compass, top = where the observer looks. */
  const onGroundHeading = useCallback((az: number) => {
    const el = diskRef.current;
    if (!el) return;
    el.style.transform = `rotate(${(-az).toFixed(1)}deg)`;
    el.style.opacity = "1";
  }, []);

  // Scale bar: re-read on every camera move; React only re-renders when the scale changes by > 1 %.
  useEffect(() => {
    if (!globe) return;
    const update = () => {
      const k = globe.kmPerPixelAtCentre();
      setKmPerPx((old) => (old != null && Math.abs(k / old - 1) < 0.01 ? old : k));
    };
    update();
    const off = globe.onCameraChange(update);
    window.addEventListener("resize", update);
    return () => {
      off();
      window.removeEventListener("resize", update);
    };
  }, [globe]);

  // Edge pointers "Sun this way / Earth this way", shown only while the body is off-screen.
  useEffect(() => {
    if (!globe || !sky) return;
    const place = (el: HTMLDivElement | null, which: "sun" | "earth") => {
      const p = globe.edgePointer(which);
      if (!el || !p) return;
      el.hidden = p.onScreen;
      el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    };
    const update = () => {
      place(sunPtrRef.current, "sun");
      place(earthPtrRef.current, "earth");
    };
    update();
    const off = globe.onCameraChange(update);
    window.addEventListener("resize", update);
    return () => {
      off();
      window.removeEventListener("resize", update);
    };
  }, [globe, sky]);

  const groundSky = useMemo(
    () => (sky && skyBody ? { sun: sky.sun, earth: sky.earth, earthToEnu: earthToEnu(skyBody, siteLat, siteLon), eclToEnu: eclToEnu(skyBody, siteLat, siteLon) } : null),
    [sky, skyBody, siteLat, siteLon],
  );

  const skyTime = Number.isNaN(startMs) ? "—" : new Date(startMs + tMin * 60_000).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

  const results = useMemo(() => index?.search(query, 12) ?? [], [index, query]);

  const goTo = (f: Feature) => {
    setQuery("");
    globe?.flyTo(f.lat, f.lon, f.radiusKm);
    globe?.showRing(f.lat, f.lon, f.radiusKm);
    setFound(f);
    if (mobile) setPanelOpen(false);
  };

  const copy = async () => {
    if (!lastClick) return;
    // Signed decimal, east-positive longitude: readable by most tools.
    const text = `${lastClick.lat.toFixed(5)}, ${roundLon(lastClick.lon, 5).toFixed(5)}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopyLabel("Copied ✓");
      setTimeout(() => setCopyLabel("Copy lat, lon"), 1200);
    } catch {
      // Clipboard refused (insecure http…): show the text, selected.
      setCopyFallback(text);
    }
  };

  const changeQuality = (dem: string) => {
    // Changing quality reloads the page: guarantees a single copy of the raster in memory.
    const url = new URL(location.href);
    url.searchParams.set("dem", dem);
    location.href = url.toString();
  };

  const loaded = globe !== null;

  return (
    <div ref={rootRef} className={`lunar${panelOpen ? "" : " panel-collapsed"}`}>
      <div ref={hostRef} className="lunar-globe" aria-label="Interactive lunar globe" />
      <div ref={tipRef} className="lunar-tooltip" role="status" aria-live="polite" hidden />

      <button
        className="lunar-panel-toggle"
        type="button"
        aria-expanded={panelOpen}
        title="Scenario & settings"
        aria-label="Scenario and settings"
        onClick={() => setPanelOpen((o) => !o)}
      >
        ⋯
      </button>

      {groundOn && (
        <GroundViewBoundary onExit={() => setGroundOn(false)}>
          <GroundViewPanel
            heightmap={heightmap}
            colorImage={colorImage}
            siteLat={siteLat}
            siteLon={siteLon}
            observerHeightM={observerHeightM}
            sky={groundSky}
            demVersion={demVersion}
            active={active}
            onExit={() => setGroundOn(false)}
            onHeading={onGroundHeading}
            tMin={tMin}
            spanMin={spanMin}
            stepMinutes={stepMinutes}
            setTime={setGroundTime}
            sunAt={sunAt}
            onMoveSite={moveSite}
          />
        </GroundViewBoundary>
      )}
      {sky && !groundOn && (
        <>
          <div ref={sunPtrRef} className="edge-ptr sun" hidden>
            <button type="button" className="edge-label" onClick={() => globe?.viewBody("sun")}>Sun</button>
          </div>
          <div ref={earthPtrRef} className="edge-ptr earth" hidden>
            <button type="button" className="edge-label" onClick={() => globe?.viewBody("earth")}>Earth</button>
          </div>
        </>
      )}
      {sky && (
        <div className="sky-overlay">
          <SkyCompass sun={sky.sun} earth={sky.earth} diskRef={diskRef} />
          <div className="sky-timebar">
            <div className="sky-time">
              <button
                type="button"
                onClick={() => setMode((m) => (m === "paused" ? "playing" : "paused"))}
                aria-label={mode === "paused" ? "Play" : "Pause"}
              >
                {mode === "paused" ? "▶" : "❚❚"}
              </button>
              <input
                type="range"
                min={0}
                max={spanMin}
                step={Math.max(1, stepMinutes)}
                value={tMin}
                onChange={(e) => {
                  setMode("paused");
                  setTMin(Number(e.target.value));
                }}
                aria-label="Scenario time"
              />
              <output>{skyTime}</output>
            </div>
          </div>
          {mode !== "live" && (
            <button type="button" className="sky-now" onClick={() => setMode("live")}>
              Now
            </button>
          )}
        </div>
      )}
      {sky && !groundOn && (
        <div className="sky-view">
          <button type="button" onClick={() => setGroundOn(true)} title="Stand at the selected site and look around">
            Ground view
          </button>
          <button
            type="button"
            aria-pressed={slopeOn}
            className={slopeOn ? "on" : undefined}
            onClick={() => setSlopeOn((on) => !on)}
            title="Colour a disc around the selected site by terrain slope (click the Moon to move it)"
          >
            Slope filter
          </button>
        </div>
      )}
      {slopeOn && !groundOn && (
        <div className="slope-filter">
          {slopeState.kind === "loading" && <div className="muted small">Opening the slope product…</div>}
          {slopeState.kind === "ready" && (
            <>
              <label className="slider">
                Max slope <output>{slopeMax.toFixed(1)}°</output>
                <input type="range" min={0.5} max={45} step={0.5} value={slopeMax} onChange={(e) => setSlopeMax(Number(e.target.value))} />
              </label>
              <div className="small">
                <span className="slope-ok">■</span> ≤ {slopeMax.toFixed(1)}° · <span className="slope-bad">■</span> steeper ·{" "}
                <span className="slope-nodata">■</span> no data
              </div>
              {(() => {
                const sc = slopeState.scope;
                const info = slopeState.info;
                if (!sc) return <div className="muted small">Click the Moon to place the disc on a site…</div>;
                const where = `Disc Ø ${(2 * sc.radiusKm).toFixed(sc.radiusKm < 5 ? 1 : 0)} km around the site (${sc.centreLat.toFixed(2)}°, ${sc.centreLon.toFixed(2)}°)`;
                if (sc.source === "none") return <div className="warn small">{where}: no relief loaded, no slope available.</div>;
                if (sc.source === "polar")
                  return (
                    <div className="small">
                      {where} · <strong>{info?.productId} 20 m</strong> slope shown at {sc.pixelM} m/px
                      {sc.level > 0 ? " (max of the 20 m pixels: conservative)" : ""}
                      {slopeProgress && <> · loading {slopeProgress.done}/{slopeProgress.total}…</>}
                    </div>
                  );
                return (
                  <div className="warn small">
                    {where} · <strong>COARSE overview</strong> (orange dashed rim): slope of the global {sc.coarseLabel} raster, ≈{" "}
                    {(sc.pixelM / 1000).toFixed(1)} km pixels. A km-scale baseline smooths the terrain: these slopes are much lower than real
                    landing-scale slopes and NOT comparable to the 20 m product
                    {info ? ` (available from the pole to ${Math.abs(info.fullCoverageLatDeg).toFixed(0)}°S)` : ""}.
                  </div>
                );
              })()}
              <div className="muted small">
                {slopeState.info
                  ? `${slopeState.info.productId}: slope on a ${slopeState.info.baselineM} m baseline (${slopeState.info.status}). `
                  : "20 m polar slope tiles not installed (slope-tiles, POLAR_DATA.md): coarse overview only. "}
                Green = slope criterion at the data's scale only, NOT a validated landing site.
              </div>
            </>
          )}
        </div>
      )}

      <div className="lunar-footnote">
        {loaded && !groundOn && <ScaleBar kmPerPx={kmPerPx} note="at view centre, reference sphere" />}
        {skyError && <div className="sky-note">Sky unavailable: {skyError}</div>}
      </div>

      <aside className="lunar-panel">
        {children && <div className="lunar-scenario">{children}</div>}
        <section>
          <h2>Last clicked point</h2>
          <div className={`readout${lastClick ? "" : " muted"}`}>
            {lastClick ? <InfoLines info={lastClick} /> : "Click the surface (long-press on touch) to place a marker and select the scenario site."}
          </div>
          <div className="row">
            <button type="button" disabled={!lastClick} onClick={copy}>
              {copyLabel}
            </button>
            <button type="button" onClick={() => globe?.clearMarkers()}>
              Clear markers
            </button>
          </div>
          {copyFallback && <input className="copy-fallback" type="text" readOnly value={copyFallback} onFocus={(e) => e.target.select()} autoFocus aria-label="Coordinates" />}
        </section>

        <section>
          <h2>Find a feature</h2>
          <input
            type="search"
            placeholder="Tycho, Mare Imbrium, Shackleton…"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && results.length > 0 && goTo(results[0])}
          />
          <ul className="lunar-results">
            {results.map((f) => (
              <li key={`${f.name}|${f.lat}|${f.lon}`}>
                <button type="button" onClick={() => goTo(f)}>
                  {f.name}
                  <small>
                    {f.type} · {f.diameterKm.toFixed(0)} km
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {found && (
            <div className="readout">
              <strong>{found.name}</strong> — {found.type}
              <br />
              {formatLat(found.lat)}, {formatLon(found.lon, found.lat)} · Ø {found.diameterKm.toFixed(1)} km
            </div>
          )}
        </section>

        <section>
          <h2>Terrain slope around the site</h2>
          {panelOpen && <SlopeMap siteLat={siteLat} siteLon={siteLon} maxSlope={slopeMax} onMaxSlope={setSlopeMax} />}
        </section>

        <section>
          <h2>Display</h2>
          <h3>Relief</h3>
          <label className="select">
            Quality
            <select value={demLabel} onChange={(e) => changeQuality(e.target.value)}>
              <option value="4">ldem_4 — 4 px/°, 4 MB (light)</option>
              <option value="16">ldem_16 — 16 px/°, 66 MB</option>
            </select>
          </label>
          <label className="slider">
            Exaggeration <output>{exag.toFixed(1)}×</output>
            <input type="range" min={0} max={10} step={0.5} value={exag} onChange={(e) => setExag(Number(e.target.value))} />
          </label>
          <label className="check">
            <input type="checkbox" checked={refine} onChange={(e) => setRefine(e.target.checked)} /> Pick on displayed relief
          </label>
          {!refine && exag >= 2 && (
            <p className="warn">
              Picking on the undisplaced sphere: with strong exaggeration the read-out point can be offset from the
              visible relief (parallax).
            </p>
          )}
          <h3>Imagery</h3>
          <label className="check">
            <input type="checkbox" checked={tilesOn} onChange={(e) => setTilesOn(e.target.checked)} /> High-res imagery
            (NASA Moon Trek, online)
          </label>
          {tilesOn && (
            <p className={tileStatus === "offline" ? "warn" : "muted small"}>
              {tileStatus === "offline"
                ? "Tiles unreachable (offline?): showing the local 4k mosaic."
                : tileStatus === "loading"
                  ? "Loading tiles… zoom in for detail (down to ≈ 100 m/px)."
                  : "Tiles loaded for the current view; zoom in for detail (down to ≈ 100 m/px)."}
            </p>
          )}
          <h3>Overlays</h3>
          <label className="check">
            <input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} /> Lat/lon grid (15°)
          </label>
        </section>

        <section className="small">
          <h2>Data &amp; limits</h2>
          <h3>Status</h3>
          <p className="muted">{dataset}</p>
          {demStreamState && (
            <p className="muted">
              {demStreamState.done
                ? `ldem_16 relief: ${demStreamState.loaded}/${demStreamState.total} bands loaded.`
                : `ldem_16 relief streaming: ${demStreamState.loaded}/${demStreamState.total} bands (nearest the site first; ldem_4 elsewhere meanwhile).`}
            </p>
          )}
          <p className="muted">
            {demLabel === "16" ? "Full relief quality (ldem_16)." : "Light relief (ldem_4): switch to ldem_16 above if installed."} Full
            quality needs the NASA/IAU data:{" "}
            <code>apps/web/scripts/setup-data.sh</code> (without <code>--light</code>) —{" "}
            <a href={DATA_README_URL} target="_blank" rel="noopener noreferrer">
              setup guide on GitHub
            </a>
            .
          </p>
          {notes.length > 0 && (
            <ul className="warn-list">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {sky && (
            <>
              <h3>Sky</h3>
              <p className="muted small">
                Sky from SPICE (DE440): geometric Sun/Earth directions at the Moon's centre, real lunar orientation
                (librations included), ideal horizon. Lighting, background Sun/Earth and compass follow it. Seen from
                the site itself the Earth can differ by up to 0.26° (parallax): the scenario result (Evaluate) gives
                the apparent directions at the site and is the reference.
              </p>
            </>
          )}
          <h3>Assumptions</h3>
          <ul>
            <li>
              Elevation: LOLA raster from the CGI Moon Kit, relative to a 1737.4 km sphere (not a geoid); interpolated
              value, accuracy limited by raster resolution.
            </li>
            <li>
              Planetocentric latitude, east-positive longitude. LOLA and the IAU gazetteer are assumed to share the same
              frame (Mean Earth / Polar Axis).
            </li>
            <li>
              Feature shown: nearest IAU centre whose circle (IAU diameter / 2) contains the point — circular
              approximation of the outlines.
            </li>
          </ul>
          <h3>Sources</h3>
          <ul className="muted">
            <li>
              Elevation and colour: NASA SVS{" "}
              <a href="https://svs.gsfc.nasa.gov/4720" target="_blank" rel="noopener">
                CGI Moon Kit
              </a>{" "}
              (LRO LROC WAC, LOLA).
            </li>
            <li>
              Feature names:{" "}
              <a href="https://planetarynames.wr.usgs.gov" target="_blank" rel="noopener">
                IAU/USGS Gazetteer of Planetary Nomenclature
              </a>
              .
            </li>
            <li>
              High-res imagery: LRO WAC global mosaic ({TREK_LAYER}, NASA/GSFC/Arizona State University) streamed from{" "}
              <a href="https://trek.nasa.gov/moon/" target="_blank" rel="noopener">
                NASA Moon Trek
              </a>{" "}
              — imagery only (its built-in shading is fixed; relief, altitude and picking still use LOLA).
            </li>
            <li>
              Landing sites (white = crewed, green = robotic, {LANDING_SITES.length} soft landings):{" "}
              <a href={LANDING_SOURCE.url} target="_blank" rel="noopener">
                LROC Anthropogenic Objects
              </a>{" "}
              ({LANDING_SOURCE.citation}; table updated {LANDING_SOURCE.updated}) — positions measured on LROC NAC images;
              spacecraft not yet located there (e.g. Luna 9, Luna 13) are not shown.
            </li>
            <li>
              Stars:{" "}
              <a href="https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50" target="_blank" rel="noopener">
                Yale Bright Star Catalogue
              </a>{" "}
              (5th rev. ed., Hoffleit &amp; Warren 1991), V ≤ 6, J2000 positions, no precession.
            </li>
          </ul>
        </section>
      </aside>

      {!loaded && (
        <div className={`lunar-loader${fatal ? " error" : ""}`}>
          <div className="loader-box">
            <div className="loader-title">Moon 3D</div>
            <div className="loader-msg">{fatal ?? `Downloading (relief ldem_${demLabel})…`}</div>
            <div className="loader-track">
              <div className="loader-bar" style={{ width: `${((loadPct ?? 0) * 100).toFixed(1)}%` }} />
            </div>
            <div className="loader-pct">{loadPct == null ? "…" : `${Math.round(loadPct * 100)} %`}</div>
          </div>
        </div>
      )}
    </div>
  );
}
