// main.js — point d'entrée : choix de qualité, chargement, interactions, CustomEvent.
//
// Événements publics (émis sur #globe, avec bubbles → écoutables sur document/window) :
//   'moonhover' et 'moonclick', detail = { lat, lon, altM, feature }
//   feature = null ou { name, type, diameterKm, lat, lon, distanceKm }
// Exemple : document.addEventListener('moonclick', (e) => console.log(e.detail));

import { FeatureIndex, publicFeature } from './features.js';
import { formatAltM, formatLat, formatLon } from './geo.js';
import { Globe } from './globe.js';
import { loadHeightmap, loadImage, loadJson } from './loaders.js';

const DATA = './data/';
// Base des rasters d'altitude : à remplacer par une URL R2/CDN (CORS requis) si ldem_16
// dépasse la limite de taille de l'hébergeur (25 Mio sur Cloudflare Pages).
const DEM_BASE = DATA;
const $ = (id) => document.getElementById(id);

// --- Qualité ------------------------------------------------------------------------
// ?dem=4 ou ?dem=16 force le choix ; sinon ldem_4 sur mobile / petit écran, ldem_16 ailleurs.
// Changer de qualité recharge la page : garantit une seule copie du raster en mémoire.
const isMobile = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;
const params = new URLSearchParams(location.search);
let dem = params.get('dem') === '4' || params.get('dem') === '16' ? params.get('dem') : (isMobile ? '4' : '16');

// ldem_16 fait 5760 px de large : impossible si la carte graphique plafonne à 4096.
const probe = document.createElement('canvas').getContext('webgl2');
const maxTex = probe ? probe.getParameter(probe.MAX_TEXTURE_SIZE) : 0;
probe?.getExtension('WEBGL_lose_context')?.loseContext();
const notes = [];
if (!probe) {
  fatal('WebGL 2 indisponible dans ce navigateur.');
  throw new Error('WebGL2 indisponible');
}
if (dem === '16' && maxTex < 5760) {
  notes.push(`Texture max ${maxTex} px : ldem_16 (5760 px) non supporté, repli sur ldem_4.`);
  dem = '4';
}

// --- Écran de chargement ------------------------------------------------------------
const parts = { color: 0, dem: 0, names: 0 };
const weights = { color: 0.25, dem: 0.65, names: 0.1 };
function progress(key, f) {
  parts[key] = f ?? parts[key];
  const total = Object.keys(parts).reduce((s, k) => s + parts[k] * weights[k], 0);
  $('loader-bar').style.width = `${(total * 100).toFixed(1)}%`;
  $('loader-pct').textContent = f == null ? '…' : `${Math.round(total * 100)} %`;
}

function fatal(msg) {
  $('loader-msg').textContent = msg;
  $('loader').classList.add('error');
}

async function boot() {
  $('loader-msg').textContent = `Téléchargement (relief ldem_${dem})…`;
  const [colorImage, heightmap, featJson] = await Promise.all([
    loadImage(`${DATA}moon_color.jpg`, (f) => progress('color', f)),
    loadHeightmap(`${DEM_BASE}ldem_${dem}.tif`, `ldem_${dem}`, (f) => progress('dem', f)),
    loadJson(`${DATA}features.json`, (f) => progress('names', f)).catch((e) => {
      notes.push(`Noms de formations indisponibles (${e.message}).`);
      return { types: {}, features: [] };
    }),
  ]);

  const segments = isMobile ? 512 : 1024;
  const globe = new Globe($('globe'), { colorImage, heightmap, segments });
  const index = new FeatureIndex(featJson);
  if (!globe.floatLinear) notes.push('Filtrage linéaire float32 indisponible : relief en échantillonnage « nearest ».');

  setupUi(globe, index, heightmap);
  $('loader').classList.add('done');
  setTimeout(() => $('loader').remove(), 600);
}

// --- Interface --------------------------------------------------------------------------
function setupUi(globe, index, heightmap) {
  const canvas = globe.renderer.domElement;
  const tip = $('tooltip');
  const host = $('globe');

  // Informations sur les données, affichées dans le panneau.
  $('dataset').textContent =
    `${heightmap.label} · ${heightmap.width}×${heightmap.height} px · ` +
    `≈ ${heightmap.kmPerPixel.toFixed(1)} km/px à l'équateur · ${index.features.length} formations`;
  $('notes').innerHTML = notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('');

  // Qualité
  $('quality').value = heightmap.label.replace('ldem_', '');
  $('quality').addEventListener('change', (e) => {
    params.set('dem', e.target.value);
    location.search = params.toString();
  });

  // Exagération
  const exag = $('exag');
  const exagVal = $('exag-val');
  const applyExag = () => {
    const x = Number(exag.value);
    globe.setExaggeration(x);
    exagVal.textContent = `${x.toFixed(1).replace('.', ',')}×`;
    updateWarning();
  };
  exag.addEventListener('input', applyExag);

  // Pointage affiné
  const refine = $('refine');
  refine.addEventListener('change', () => {
    globe.refinePick = refine.checked;
    updateWarning();
  });
  function updateWarning() {
    $('pick-warning').hidden = globe.refinePick || globe.exaggeration < 2;
  }
  applyExag();

  // Grille
  $('grid').addEventListener('change', (e) => globe.setGridVisible(e.target.checked));

  // Panneau repliable
  $('panel-toggle').addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('panel-collapsed');
    $('panel-toggle').setAttribute('aria-expanded', String(!collapsed));
  });
  if (isMobile) document.body.classList.add('panel-collapsed');

  // --- Survol (throttlé par requestAnimationFrame) ---------------------------------
  let pending = null;
  let scheduled = false;
  function queueHover(x, y) {
    pending = { x, y };
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (pending) hover(pending.x, pending.y);
    });
  }

  function describe(x, y) {
    const hit = globe.pick(x, y);
    if (!hit) return null;
    const f = index.nearest(hit.lat, hit.lon);
    return { lat: hit.lat, lon: hit.lon, altM: hit.altM, feature: publicFeature(f) };
  }

  function hover(x, y) {
    const info = describe(x, y);
    if (!info) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = tooltipHtml(info);
    tip.hidden = false;
    placeTooltip(tip, x, y);
    host.dispatchEvent(new CustomEvent('moonhover', { detail: info, bubbles: true }));
  }

  function click(x, y) {
    const info = describe(x, y);
    if (!info) return;
    globe.addMarker(info.lat, info.lon);
    showLastClick(info);
    host.dispatchEvent(new CustomEvent('moonclick', { detail: info, bubbles: true }));
  }

  // Souris : survol continu ; clic = pression/relâchement sans glisser.
  // Tactile : tap = survol (infobulle) ; appui long (≥ 550 ms) = clic (marqueur).
  let down = null;
  let longTimer = 0;
  canvas.addEventListener('pointermove', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) {
      down.moved = true;
      clearTimeout(longTimer);
    }
    if (e.pointerType === 'mouse') queueHover(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, moved: false, type: e.pointerType, long: false };
    if (e.pointerType !== 'mouse') {
      longTimer = setTimeout(() => {
        if (down && !down.moved) {
          down.long = true;
          click(down.x, down.y);
          navigator.vibrate?.(15);
        }
      }, 550);
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    clearTimeout(longTimer);
    if (!down || down.moved) {
      down = null;
      return;
    }
    if (down.type === 'mouse') click(e.clientX, e.clientY);
    else if (!down.long) hover(e.clientX, e.clientY);
    down = null;
  });
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') tip.hidden = true;
  });

  // --- Dernier clic -------------------------------------------------------------------
  let last = null;
  function showLastClick(info) {
    last = info;
    $('last-click').innerHTML = tooltipHtml(info);
    $('copy').disabled = false;
  }
  $('copy').addEventListener('click', async () => {
    if (!last) return;
    // Format décimal signé, lisible par la plupart des outils (lat, lon est-positive).
    const text = `${last.lat.toFixed(5)}, ${last.lon.toFixed(5)}`;
    try {
      await navigator.clipboard.writeText(text);
      flash($('copy'), 'Copié ✓');
    } catch {
      // Presse-papiers refusé (http non sécurisé…) : on affiche le texte sélectionné.
      $('copy-fallback').value = text;
      $('copy-fallback').hidden = false;
      $('copy-fallback').select();
    }
  });
  $('clear-markers').addEventListener('click', () => globe.clearMarkers());

  // --- Recherche de formation ---------------------------------------------------------
  const input = $('search');
  const list = $('results');
  input.addEventListener('input', () => {
    const res = index.search(input.value, 12);
    list.innerHTML = res
      .map((f, i) => `<li><button type="button" data-i="${i}">${escapeHtml(f.name)}` +
        `<small>${escapeHtml(f.type)} · ${f.diameterKm.toFixed(0)} km</small></button></li>`)
      .join('');
    list._results = res;
  });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-i]');
    if (!btn) return;
    const f = list._results[Number(btn.dataset.i)];
    goTo(f);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && list._results?.length) goTo(list._results[0]);
  });
  function goTo(f) {
    globe.flyTo(f.lat, f.lon, f.radiusKm);
    globe.showRing(f.lat, f.lon, f.radiusKm);
    $('found').innerHTML =
      `<strong>${escapeHtml(f.name)}</strong> — ${escapeHtml(f.type)}<br>` +
      `${formatLat(f.lat)}, ${formatLon(f.lon, f.lat)} · Ø ${f.diameterKm.toFixed(1).replace('.', ',')} km`;
    if (isMobile) document.body.classList.add('panel-collapsed');
  }
}

function tooltipHtml({ lat, lon, altM, feature }) {
  const name = feature
    ? `<div class="feat">${escapeHtml(feature.name)} <small>${escapeHtml(feature.type)}` +
      ` · ${feature.distanceKm.toFixed(0)} km du centre</small></div>`
    : '<div class="feat none">Aucune formation nommée</div>';
  return `<div>${formatLat(lat)} &nbsp; ${formatLon(lon, lat)}</div>` +
    `<div>Altitude ${formatAltM(altM)}</div>${name}`;
}

function placeTooltip(tip, x, y) {
  const pad = 16;
  const r = tip.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + r.width > innerWidth - 8) left = x - r.width - pad;
  if (top + r.height > innerHeight - 8) top = y - r.height - pad;
  tip.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
}

function flash(el, text) {
  const old = el.textContent;
  el.textContent = text;
  setTimeout(() => (el.textContent = old), 1200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

boot().catch((e) => {
  console.error(e);
  fatal(`Échec du chargement : ${e.message}. Les données sont-elles installées (./setup.sh) ?`);
});
