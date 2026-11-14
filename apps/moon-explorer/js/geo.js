// geo.js — conversions de coordonnées lunaires et formatage.
// Module pur (sans three.js ni DOM) : testable avec `node --test`.
//
// Conventions (voir README, section « Conventions ») :
//  - latitude planétocentrique en degrés, [-90, 90] ;
//  - longitude positive vers l'est, normalisée dans [-180, 180) ;
//  - rayon de référence R = 1737,4 km (sphère IAU/LOLA utilisée par le CGI Moon Kit).

export const MOON_RADIUS_KM = 1737.4;

const DEG = Math.PI / 180;

/** Ramène une longitude (degrés) dans [-180, 180). */
export function normalizeLon(lon) {
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  return l === 180 ? -180 : l;
}

/**
 * UV three.js (SphereGeometry) → lat/lon, formules demandées :
 *   lon = u*360 - 180, lat = v*180 - 90.
 * Valable parce que les textures sont équirectangulaires et centrées sur 0° de longitude.
 */
export function uvToLatLon(u, v) {
  return { lat: v * 180 - 90, lon: normalizeLon(u * 360 - 180) };
}

/**
 * Point 3D (repère de la scène) → UV de la SphereGeometry three.js.
 * three.js construit la sphère avec x = -cos(φ)·sin(θ), y = cos(θ), z = sin(φ)·sin(θ),
 * φ = u·2π, θ = (1 - v)·π. On inverse ces relations ; le rayon du point est ignoré.
 * Conséquence : lon 0° sur +X, lon +90° (est) sur -Z, pôle nord sur +Y.
 */
export function pointToUv(x, y, z) {
  const r = Math.hypot(x, y, z);
  const theta = Math.acos(Math.max(-1, Math.min(1, y / r)));
  let phi = Math.atan2(z, -x); // dans (-π, π]
  if (phi < 0) phi += 2 * Math.PI;
  return { u: phi / (2 * Math.PI), v: 1 - theta / Math.PI };
}

/** lat/lon (degrés) → vecteur unitaire dans le repère de la scène (inverse de pointToUv). */
export function latLonToUnit(lat, lon) {
  const phi = (lon + 180) * DEG; // φ = u·2π avec u = (lon+180)/360
  const theta = (90 - lat) * DEG;
  return {
    x: -Math.cos(phi) * Math.sin(theta),
    y: Math.cos(theta),
    z: Math.sin(phi) * Math.sin(theta),
  };
}

/** Distance orthodromique (haversine) en km sur la sphère de rayon R. */
export function haversineKm(lat1, lon1, lat2, lon2, R = MOON_RADIUS_KM) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** « 12,345° N » / « 45,678° O ». La longitude est indéfinie exactement aux pôles. */
export function formatLat(lat, digits = 3) {
  const h = lat >= 0 ? 'N' : 'S';
  return `${Math.abs(lat).toFixed(digits).replace('.', ',')}° ${h}`;
}

export function formatLon(lon, lat = 0, digits = 3) {
  if (Math.abs(lat) > 89.9999) return '— (pôle)';
  const l = normalizeLon(lon);
  const h = l >= 0 ? 'E' : 'O';
  return `${Math.abs(l).toFixed(digits).replace('.', ',')}° ${h}`;
}

export function formatAltM(altM) {
  if (altM == null || !Number.isFinite(altM)) return '—';
  return `${Math.round(altM).toLocaleString('fr-FR')} m`;
}
