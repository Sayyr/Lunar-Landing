// VISUALIZATION ONLY: maps planetocentric lat/lon to points on the unit display sphere.
// Authoritative geometry lives in services/science; never compute astronomy here.
//
// Display convention (Three.js is Y-up): body-fixed +Z (north pole) -> three +Y,
// body-fixed +X (lon 0) -> three +X, body-fixed +Y (lon +90 E) -> three -Z.

const DEG = Math.PI / 180;

export function wrapLongitudeDeg(lon: number): number {
  const w = ((((lon + 180) % 360) + 360) % 360) - 180;
  return w >= 180 ? w - 360 : w;
}

export function latLonToDisplay(latDeg: number, lonDeg: number, radius = 1): [number, number, number] {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return [radius * Math.cos(lat) * Math.cos(lon), radius * Math.sin(lat), -radius * Math.cos(lat) * Math.sin(lon)];
}

export function displayToLatLon(x: number, y: number, z: number): { latitude_deg: number; longitude_deg: number } {
  const r = Math.hypot(x, y, z);
  if (r === 0) throw new Error("zero vector has no direction");
  const lat = Math.asin(Math.max(-1, Math.min(1, y / r))) / DEG;
  // At the poles longitude is undefined; atan2(0, 0) = 0 gives a deterministic 0.
  const lon = wrapLongitudeDeg(Math.atan2(-z, x) / DEG);
  return { latitude_deg: lat, longitude_deg: lon };
}
