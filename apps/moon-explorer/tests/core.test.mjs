// Tests des modules purs : `node --test tests/` (Node ≥ 20, aucune dépendance).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FeatureIndex, normalizeName } from '../js/features.js';
import {
  formatLat, formatLon, haversineKm, latLonToUnit, normalizeLon, pointToUv, uvToLatLon,
} from '../js/geo.js';
import { Heightmap, flipRowsInPlace } from '../js/heightmap.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

test('normalizeLon ramène dans [-180, 180)', () => {
  assert.equal(normalizeLon(180), -180);
  assert.equal(normalizeLon(-180), -180);
  assert.equal(normalizeLon(358.5), -1.5);
  assert.equal(normalizeLon(540), -180);
  assert.equal(normalizeLon(-190), 170);
});

test('formules UV demandées : lon = u*360-180, lat = v*180-90', () => {
  assert.deepEqual(uvToLatLon(0.5, 0.5), { lat: 0, lon: 0 });
  assert.deepEqual(uvToLatLon(0.75, 1), { lat: 90, lon: 90 });
  assert.deepEqual(uvToLatLon(1, 0), { lat: -90, lon: -180 });
});

test('orientation three.js : lon 0 sur +X, lon +90 E sur -Z, nord sur +Y', () => {
  let p = latLonToUnit(0, 0);
  close(p.x, 1); close(p.y, 0); close(p.z, 0);
  p = latLonToUnit(0, 90);
  close(p.x, 0); close(p.z, -1);
  p = latLonToUnit(90, 0);
  close(p.y, 1);
});

test('latLonToUnit ∘ pointToUv ∘ uvToLatLon = identité (hors pôles)', () => {
  for (const [lat, lon] of [[0, 0], [45, 120], [-30, -170], [89.5, 10], [-89.5, -100], [12, 179.9]]) {
    const p = latLonToUnit(lat, lon);
    const { u, v } = pointToUv(p.x * 1.3, p.y * 1.3, p.z * 1.3); // rayon quelconque
    const r = uvToLatLon(u, v);
    close(r.lat, lat, 1e-9);
    close(haversineKm(lat, lon, r.lat, r.lon), 0, 1e-6);
  }
});

test('haversine : quart de méridien et symétrie', () => {
  close(haversineKm(0, 0, 90, 0), (Math.PI / 2) * 1737.4, 1e-6);
  close(haversineKm(10, 20, -5, 170), haversineKm(-5, 170, 10, 20), 1e-9);
  close(haversineKm(0, 179.9, 0, -179.9), 0.2 * (Math.PI / 180) * 1737.4, 1e-6); // antiméridien
});

test('formatage N/S/E/O et pôle', () => {
  assert.equal(formatLat(-43.31), '43,310° S');
  assert.equal(formatLon(-11.36), '11,360° O');
  assert.equal(formatLon(20, 90), '— (pôle)');
});

test('flipRowsInPlace inverse les lignes sans perdre de données', () => {
  const W = 3; const H = 5;
  const d = Float32Array.from({ length: W * H }, (_, i) => i);
  flipRowsInPlace(d, W, H);
  assert.deepEqual([...d.subarray(0, 3)], [12, 13, 14]);
  assert.deepEqual([...d.subarray(6, 9)], [6, 7, 8]); // ligne centrale inchangée
  assert.deepEqual([...d.subarray(12, 15)], [0, 1, 2]);
});

test('Heightmap : pixel ↔ lat/lon, interpolation et raccord ±180°', () => {
  // 8×4 px : ligne 0 du TIFF = nord. On marque le pixel (ligne 0, colonne 0).
  const W = 8; const H = 4;
  const d = new Float32Array(W * H);
  d[0] = 4; // centre : lat 90 - 22,5 = 67,5 ; lon -180 + 22,5 = -157,5
  d[W - 1] = 2; // colonne 7 : lon 157,5
  flipRowsInPlace(d, W, H);
  const hm = new Heightmap(d, W, H);
  close(hm.sampleKm(67.5, -157.5), 4);
  close(hm.sampleKm(67.5, 157.5), 2);
  close(hm.sampleKm(67.5, 180), 3); // milieu entre colonnes 7 et 0 → raccord continu
  close(hm.sampleKm(67.5, -180), 3);
  close(hm.sampleKm(89.9, -157.5), 4); // au-delà du dernier centre : bornage
  close(hm.sampleKm(-67.5, -157.5), 0);
  assert.equal(hm.maxKm, 4);
});

const FIXTURE = {
  types: { AA: 'Crater, craters', ME: 'Mare, maria' },
  features: [
    ['Tycho', 'AA', 85.29, -43.2961, -11.2152],
    ['Tycho A', 'AA', 29.0, -39.9, -12.1],
    ['Mare Imbrium', 'ME', 1146, 34.72, -14.91],
    ['Shackleton', 'AA', 20.9, -89.67, 129.78],
    ['Bord', 'AA', 10, 0, 179.95],
    ['Polaire', 'AA', 60, -89.5, 0], // fictive : test de traversée du pôle
  ],
};

test('FeatureIndex.nearest : dans le rayon seulement', () => {
  const idx = new FeatureIndex(FIXTURE);
  assert.equal(idx.nearest(-43.3, -11.2).name, 'Tycho');
  assert.equal(idx.nearest(-39.9, -12.1).name, 'Tycho A');
  assert.equal(idx.nearest(0, 90), null);
  assert.equal(idx.nearest(34, -15).name, 'Mare Imbrium'); // grande formation (liste linéaire)
});

test('FeatureIndex.nearest : pôle et antiméridien', () => {
  const idx = new FeatureIndex(FIXTURE);
  assert.equal(idx.nearest(-89.7, 120).name, 'Shackleton');
  assert.equal(idx.nearest(-90, 0).name, 'Shackleton'); // 10,0 km du centre < 10,45 km
  assert.equal(idx.nearest(-89.6, -150).name, 'Polaire'); // de l'autre côté du pôle (26 km ; Shackleton à 14 km > 10,45)
  assert.equal(idx.nearest(0, -179.95).name, 'Bord'); // traverse ±180°
});

test("FeatureIndex.nearest coïncide avec une recherche exhaustive", () => {
  // Formations pseudo-aléatoires déterministes (LCG), rayons ≤ 150 km et quelques grandes.
  let s = 42;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const feats = [];
  for (let i = 0; i < 3000; i++) {
    const lat = Math.asin(2 * rnd() - 1) * 180 / Math.PI;
    feats.push([`F${i}`, 'AA', i % 100 === 0 ? 600 * rnd() + 300 : 300 * rnd(), lat, 360 * rnd() - 180]);
  }
  const idx = new FeatureIndex({ types: {}, features: feats });
  for (let k = 0; k < 2000; k++) {
    const lat = k < 100 ? 85 + 5 * rnd() : Math.asin(2 * rnd() - 1) * 180 / Math.PI;
    const lon = 360 * rnd() - 180;
    let best = null; let bd = Infinity;
    for (const f of idx.features) {
      const d = haversineKm(lat, lon, f.lat, f.lon);
      if (d <= f.radiusKm && d < bd) { bd = d; best = f; }
    }
    assert.equal(idx.nearest(lat, lon)?.name ?? null, best?.name ?? null, `lat ${lat} lon ${lon}`);
  }
});

test('FeatureIndex.search : accents, préfixe, taille', () => {
  const idx = new FeatureIndex(FIXTURE);
  assert.equal(normalizeName('Ångström'), 'angstrom');
  assert.deepEqual(idx.search('tycho').map((f) => f.name), ['Tycho', 'Tycho A']);
  assert.equal(idx.search('imbr')[0].name, 'Mare Imbrium');
  assert.deepEqual(idx.search(''), []);
});
