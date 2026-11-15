import * as THREE from "three";

import { DEG } from "./constants";
import { eclToThree, type V3 } from "./sceneFrame";
import data from "./stars.json";

type Star = [number, number, number, number | null];

const STARS = data.stars as Star[];
const OBLIQUITY_J2000 = 23.4392911 * DEG;
const BUCKETS = [
  { maxMag: 1.5, size: 3 },
  { maxMag: 3.5, size: 2 },
  { maxMag: Infinity, size: 1.3 },
];
const BLUE = new THREE.Color("#9bb0ff");
const ORANGE = new THREE.Color("#ffcc6f");

export function equatorialToEcliptic(raDeg: number, decDeg: number): V3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const [x, y, z] = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  const [c, s] = [Math.cos(OBLIQUITY_J2000), Math.sin(OBLIQUITY_J2000)];
  return [x, c * y + s * z, -s * y + c * z];
}

function starColor(mag: number, bv: number | null, out: THREE.Color): THREE.Color {
  const t = THREE.MathUtils.clamp(((bv ?? 0.6) + 0.3) / 2.1, 0, 1);
  const intensity = THREE.MathUtils.clamp((6.5 - mag) / 6.5, 0.2, 1);
  return out.lerpColors(BLUE, ORANGE, t).multiplyScalar(intensity);
}

export function makeStarField(radius: number): THREE.Group {
  const group = new THREE.Group();
  const color = new THREE.Color();
  let minMag = -Infinity;
  for (const { maxMag, size } of BUCKETS) {
    const stars = STARS.filter(([, , mag]) => mag >= minMag && mag < maxMag);
    minMag = maxMag;
    const positions = new Float32Array(stars.length * 3);
    const colors = new Float32Array(stars.length * 3);
    stars.forEach(([ra, dec, mag, bv], i) => {
      positions.set(eclToThree(equatorialToEcliptic(ra, dec), radius), i * 3);
      starColor(mag, bv, color).toArray(colors, i * 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, depthWrite: false, toneMapped: false });
    group.add(new THREE.Points(geometry, material));
  }
  return group;
}

export function disposeStarField(group: THREE.Group): void {
  for (const child of group.children) {
    const points = child as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
    points.geometry.dispose();
    points.material.dispose();
  }
}
