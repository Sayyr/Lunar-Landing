// features.js — formations nommées (IAU / USGS Gazetteer of Planetary Nomenclature).
// Module pur (sans three.js ni DOM) : testable avec `node --test`.
//
// Index spatial : grille lat/lon de CELL_DEG degrés. Chaque petite formation est rangée
// dans la cellule de son centre ; une requête n'inspecte que les cellules situées à moins
// de BIG_RADIUS_KM du point. Les grandes formations (rayon > BIG_RADIUS_KM : mers,
// bassins…) sont peu nombreuses et testées linéairement. Coût par survol : quelques
// dizaines de haversines au lieu de ~9 000.

import { MOON_RADIUS_KM, haversineKm, normalizeLon } from './geo.js';

const CELL_DEG = 5;
const BIG_RADIUS_KM = 150;
const ROWS = 180 / CELL_DEG;
const COLS = 360 / CELL_DEG;

/** Minuscules sans diacritiques, pour la recherche par nom. */
export function normalizeName(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export class FeatureIndex {
  /**
   * @param {object} json  contenu de data/features.json (voir scripts/build_features.py)
   */
  constructor(json) {
    this.types = json.types || {};
    this.features = json.features.map(([name, code, diameterKm, lat, lon]) => ({
      name,
      code,
      type: this.types[code] || code,
      diameterKm,
      radiusKm: diameterKm / 2,
      lat,
      lon: normalizeLon(lon),
      key: normalizeName(name),
    }));
    this.big = [];
    this.grid = Array.from({ length: ROWS * COLS }, () => []);
    for (const f of this.features) {
      if (f.radiusKm > BIG_RADIUS_KM) this.big.push(f);
      else this.grid[this.#cell(f.lat, f.lon)].push(f);
    }
  }

  #row(lat) {
    return Math.min(ROWS - 1, Math.max(0, Math.floor((lat + 90) / CELL_DEG)));
  }

  #col(lon) {
    return ((Math.floor((normalizeLon(lon) + 180) / CELL_DEG) % COLS) + COLS) % COLS;
  }

  #cell(lat, lon) {
    return this.#row(lat) * COLS + this.#col(lon);
  }

  /**
   * Formation dont le centre est le plus proche du point, retenue uniquement si le point
   * est à l'intérieur de son rayon (diamètre IAU / 2). Retourne null sinon.
   */
  nearest(lat, lon) {
    let best = null;
    let bestD = Infinity;
    const test = (f) => {
      const d = haversineKm(lat, lon, f.lat, f.lon);
      if (d <= f.radiusKm && d < bestD) {
        bestD = d;
        best = f;
      }
    };

    for (const f of this.big) test(f);

    // Fenêtre de recherche : BIG_RADIUS_KM en latitude…
    const dLat = (BIG_RADIUS_KM / MOON_RADIUS_KM) * (180 / Math.PI);
    const r0 = this.#row(lat - dLat);
    const r1 = this.#row(lat + dLat);
    // …et en longitude, élargie par 1/cos(lat). Près des pôles (fenêtre > 180°) on prend
    // toutes les colonnes : traitement polaire déterministe, sans division par ~0.
    const maxAbsLat = Math.min(90, Math.abs(lat) + dLat);
    const cosLat = Math.cos((maxAbsLat * Math.PI) / 180);
    const dLon = cosLat > 1e-6 ? dLat / cosLat : Infinity;
    // Une cellule de marge de chaque côté couvre l'approximation petits angles.
    const allCols = dLon >= 150;
    const c0 = allCols ? 0 : Math.floor((normalizeLon(lon - dLon) + 180) / CELL_DEG) - 1 + COLS;
    const span = allCols ? COLS : Math.ceil((2 * dLon) / CELL_DEG) + 3;

    for (let r = r0; r <= r1; r++) {
      for (let k = 0; k < Math.min(span, COLS); k++) {
        const c = (c0 + k) % COLS;
        for (const f of this.grid[r * COLS + c]) test(f);
      }
    }
    return best ? { ...best, distanceKm: bestD } : null;
  }

  /** Recherche par nom : exact > préfixe > début de mot > sous-chaîne ; puis par taille. */
  search(query, limit = 10) {
    const q = normalizeName(query);
    if (!q) return [];
    const scored = [];
    for (const f of this.features) {
      const i = f.key.indexOf(q);
      if (i < 0) continue;
      let score = 3;
      if (f.key === q) score = 0;
      else if (i === 0) score = 1;
      else if (f.key[i - 1] === ' ' || f.key[i - 1] === '-') score = 2;
      scored.push([score, -f.diameterKm, f]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return scored.slice(0, limit).map((s) => s[2]);
  }
}

/** Version publique (sérialisable) d'une formation, pour les CustomEvent. */
export function publicFeature(f) {
  if (!f) return null;
  return {
    name: f.name,
    type: f.type,
    diameterKm: f.diameterKm,
    lat: f.lat,
    lon: f.lon,
    distanceKm: f.distanceKm,
  };
}
