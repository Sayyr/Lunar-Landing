// VISUALIZATION ONLY: maps the ecliptic-of-date frame of the celestial state onto Three.js world axes.
// Same axes as the lunar globe (lunar/geo.ts latLonToUnit; Three.js is Y-up):
//   ecliptic +X (equinox) -> three +X,  ecliptic +Z (north ecliptic pole) -> three +Y,
//   ecliptic +Y (λ = 90°) -> three −Z.
// So the ecliptic plane is the Three.js XZ plane.

import { Matrix4 } from "three";

export type V3 = [number, number, number];

export function eclToThree(v: readonly number[], scale = 1): V3 {
  return [v[0] * scale, v[2] * scale, -v[1] * scale];
}

function threeToEcl(u: V3): V3 {
  return [u[0], -u[2], u[1]];
}

/**
 * Converts a row-major 3×3 rotation "body-fixed → ecliptic" into a Three.js Matrix4 that rotates
 * a mesh whose local axes follow the same Y-up convention (P · M · Pᵀ). A sphere textured with an
 * equirectangular map (lon −180 at the left edge) then has lon 0 on local +X and north on local +Y.
 */
export function bodyRotationToThree(m: readonly number[]): Matrix4 {
  const basis: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const cols = basis.map((e) => {
    const b = threeToEcl(e);
    const r: V3 = [
      m[0] * b[0] + m[1] * b[1] + m[2] * b[2],
      m[3] * b[0] + m[4] * b[1] + m[5] * b[2],
      m[6] * b[0] + m[7] * b[1] + m[8] * b[2],
    ];
    return eclToThree(r);
  });
  // Matrix4.set is row-major.
  return new Matrix4().set(
    cols[0][0], cols[1][0], cols[2][0], 0,
    cols[0][1], cols[1][1], cols[2][1], 0,
    cols[0][2], cols[1][2], cols[2][2], 0,
    0, 0, 0, 1,
  );
}

/**
 * VISUALIZATION ONLY: makes an almost-closed trace end exactly where it starts by spreading the
 * residual (last − first) linearly along it. Used for the Moon's path over one sidereal month,
 * which does not close in reality (solar perturbations, apsidal precession).
 */
export function closeLoop(points: readonly V3[]): V3[] {
  const n = points.length - 1;
  if (n < 1) return [...points];
  const [a, b] = [points[0], points[n]];
  const d: V3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  return points.map((p, i) => [p[0] + (d[0] * i) / n, p[1] + (d[1] * i) / n, p[2] + (d[2] * i) / n]);
}

export function normalize(v: readonly number[]): V3 {
  const r = Math.hypot(v[0], v[1], v[2]);
  if (r === 0) throw new Error("zero vector has no direction");
  return [v[0] / r, v[1] / r, v[2] / r];
}
