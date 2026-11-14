// Slope "scope" draped on the globe: a disc centred on the SELECTED SITE (the clicked point), green
// where slope ≤ the chosen maximum, red where steeper, grey where there is no data. Source: the
// derived LOLA 20 m slope tiles (slopeProduct.ts) when they cover the site, else a coarse slope of
// the global display raster (coarseSlope.ts, flagged in the UI and by an orange dashed rim). The
// threshold is a shader uniform (no request, no rebuild); a new site or zoom rebuilds the disc at
// the pyramid level matching its size (20 m pixels close up, coarser when zoomed out).
//
// Geometry: a regular grid in the site's local east/north frame (azimuthal equidistant, see
// localFrame), each vertex placed at its lat/lon on the sphere and displaced by the globe's own
// height raster, plus a small lift so the disc is not buried by the globe mesh. Display only: the
// authoritative check is the server's (POST /terrain/slope/check).

import * as THREE from "three";

import { DEG } from "../lib/constants";
import { coarseSlopeDeg } from "./coarseSlope";
import { latLonToUnit, MOON_RADIUS_KM, pointToUv, uvToLatLon } from "./geo";
import type { Heightmap } from "./heightmap";
import { type PolarManifest, polarPixel, toLevel } from "./polarDem";
import type { SlopeProduct } from "./slopeProduct";

/** Texels across the disc diameter: sets the pyramid level for a given disc size. */
const TEX = 512;
/** Grid cells across the disc (vertex density of the draped mesh). */
const GRID = 160;
/** Lift above the displayed surface, km (× exaggeration), with a floor in scene units. */
const LIFT_KM = 0.6;
const LIFT_MIN = 0.00025;

export interface SlopeProductInfo {
  productId: string;
  baselineM: number;
  status: string;
  /** every longitude is covered from the pole down to this latitude (circle inscribed in the square) */
  fullCoverageLatDeg: number;
}

export interface ScopeInfo {
  centreLat: number;
  centreLon: number;
  radiusKm: number;
  /** polar = 20 m LOLA slope tiles; coarse = slope of the global display raster; none = nothing drawn */
  source: "polar" | "coarse" | "none";
  /** pyramid level (polar only, else −1) */
  level: number;
  /** pixel size of the slope shown, metres (equatorial for the coarse raster) */
  pixelM: number;
  coarseLabel?: string;
}

/**
 * Local east/north frame at (lat, lon) on the unit sphere (three.js axes, y = north pole):
 * at(eKm, nKm) = the point at that great-circle distance and bearing (azimuthal equidistant).
 * At the exact pole east is taken along the given longitude's east direction (deterministic).
 */
export function localFrame(lat: number, lon: number): { at(eKm: number, nKm: number): { lat: number; lon: number } } {
  const vec = (la: number, lo: number) => {
    const u = latLonToUnit(la, lo);
    return new THREE.Vector3(u.x, u.y, u.z);
  };
  const c = vec(lat, lon);
  const pole = new THREE.Vector3(0, 1, 0);
  let east = new THREE.Vector3().crossVectors(pole, c);
  if (east.lengthSq() < 1e-18) east = new THREE.Vector3().crossVectors(pole, vec(0, lon));
  east.normalize();
  const north = new THREE.Vector3().crossVectors(c, east).normalize();
  // Scratch vectors: at() runs ~290k times per disc rebuild, no per-call Vector3 allocation.
  const p = new THREE.Vector3();
  const dir = new THREE.Vector3();
  return {
    at(eKm, nKm) {
      const d = Math.hypot(eKm, nKm) / MOON_RADIUS_KM;
      if (d === 0) return { lat, lon };
      dir.copy(east).multiplyScalar(eKm).addScaledVector(north, nKm).normalize();
      p.copy(c).multiplyScalar(Math.cos(d)).addScaledVector(dir, Math.sin(d));
      const { u, v } = pointToUv(p.x, p.y, p.z);
      return uvToLatLon(u, v);
    },
  };
}

/** Spherical polar stereographic inverse: level-0 pixel coordinates → planetocentric lat/lon (deg). */
export function polarInverse(m: PolarManifest, line: number, sample: number): { lat: number; lon: number } {
  const p = m.projection;
  const x = (sample - p.sample_off) * p.scale_m;
  const y = p.sign_line * (line - p.line_off) * p.scale_m;
  const rho = Math.hypot(x, y);
  const colat = 2 * Math.atan(rho / (2 * p.radius_m));
  const south = p.center_lat < 0;
  const lat = south ? -90 + colat / DEG : 90 - colat / DEG;
  // At rho = 0 the longitude is undefined: deterministic fallback = centre longitude.
  let lon = rho === 0 ? p.center_lon : p.center_lon + Math.atan2(x, p.sign_y * y) / DEG;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat, lon };
}

const vertexShader = /* glsl */ `
  uniform sampler2D heightTex;
  uniform float useHeight;
  uniform float scale;
  uniform float lift;
  attribute vec2 huv;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    float h = useHeight > 0.5 ? texture2D(heightTex, huv).r : 0.0;
    vec3 p = normalize(position) * (1.0 + h * scale + lift);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D slopeTex;
  uniform float maxSlope;
  uniform float opacity;
  uniform float coarse; // 1: coarse global raster (orange dashed rim), 0: 20 m polar product (white rim)
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0; // 0 at the centre, 1 on the rim
    if (d > 1.0) discard;
    float w = fwidth(d) * 1.5;
    if (d > 1.0 - w * 2.0) {
      if (coarse > 0.5) {
        float a = atan(vUv.y - 0.5, vUv.x - 0.5);
        if (fract(a * 12.0 / 3.14159265) < 0.5) discard; // dashes
        gl_FragColor = vec4(1.0, 0.6, 0.1, 0.95);
      } else {
        gl_FragColor = vec4(1.0, 1.0, 1.0, 0.9);
      }
      return;
    }
    float s = texture2D(slopeTex, vUv).r;
    if (s < 0.0) { gl_FragColor = vec4(0.35, 0.35, 0.35, opacity * 0.6); return; } // no data
    if (s <= maxSlope) {
      float t = maxSlope > 0.0 ? s / maxSlope : 0.0; // flatter = brighter
      gl_FragColor = vec4(mix(vec3(0.10, 0.95, 0.40), vec3(0.15, 0.55, 0.25), t), opacity);
    } else {
      float t = clamp((s - maxSlope) / 20.0, 0.0, 1.0);
      gl_FragColor = vec4(mix(vec3(0.95, 0.30, 0.20), vec3(0.75, 0.05, 0.05), t), opacity);
    }
  }
`;

export class SlopeScope {
  readonly object: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** the 20 m polar product, null when its tiles are not installed (coarse source only) */
  readonly info: SlopeProductInfo | null;
  private readonly dem: SlopeProduct["dem"] | null;
  private readonly manifest: PolarManifest | null;
  private slopeTex: THREE.DataTexture | null = null;
  private request = 0;

  /**
   * @param product   the shared 20 m slope product (slopeProduct.ts), null when not installed:
   *                  the coarse source is then used everywhere
   * @param heightTex the globe's height raster texture (displacement), null without relief
   */
  constructor(product: SlopeProduct | null, heightTex: THREE.Texture | null) {
    this.dem = product?.dem ?? null;
    this.manifest = product?.dem.manifest ?? null;
    const m = this.manifest;
    this.info =
      product && m
        ? {
            productId: product.productId,
            baselineM: product.manifest.method.baseline_m,
            status: product.manifest.status,
            fullCoverageLatDeg: polarInverse(m, m.projection.line_off, m.levels[0].samples - 0.5).lat,
          }
        : null;
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        slopeTex: { value: null },
        heightTex: { value: heightTex },
        useHeight: { value: heightTex ? 1 : 0 },
        scale: { value: 0 },
        lift: { value: LIFT_MIN },
        maxSlope: { value: 10 },
        opacity: { value: 0.6 },
        coarse: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.object = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.object.renderOrder = 3; // after the base mesh (1) and the imagery tiles
    this.object.frustumCulled = false; // vertices move in the shader
    this.object.visible = false;
  }

  /**
   * Hides the disc and abandons any pending update (its tiles may still arrive; it will not show
   * the disc again). Used when the filter is switched off mid-load.
   */
  cancel(): void {
    this.request++;
    this.object.visible = false;
  }

  /**
   * Moves the disc to (lat, lon) with the given surface radius. Fetches the needed tiles at the
   * level whose pixel matches radius / TEX, then rebuilds texture and mesh. A newer call (or
   * cancel()) supersedes a pending one. Resolves with what is now shown (null if superseded).
   */
  async update(
    lat: number,
    lon: number,
    radiusKm: number,
    coarse: Heightmap | null,
    onProgress?: (done: number, total: number) => void,
  ): Promise<ScopeInfo | null> {
    const id = ++this.request;
    const radiusM = radiusKm * 1000;
    // Source: the 20 m polar product when it covers the centre, else the coarse global raster.
    const dem = this.dem;
    const m = this.manifest;
    const polar = !!dem && !!m && dem.covers(lat, lon);
    const level = dem && m ? Math.min(dem.levelForSpacing((2 * radiusM) / TEX), m.levels.length - 1) : -1;
    const base: ScopeInfo = polar
      ? { centreLat: lat, centreLon: lon, radiusKm, source: "polar", level, pixelM: m!.levels[level].scale_m }
      : coarse
        ? { centreLat: lat, centreLon: lon, radiusKm, source: "coarse", level: -1, pixelM: coarse.kmPerPixel * 1000, coarseLabel: coarse.label }
        : { centreLat: lat, centreLon: lon, radiusKm, source: "none", level: -1, pixelM: NaN };
    if (base.source === "none") {
      this.object.visible = false;
      return base;
    }
    if (polar) {
      await dem!.loadAround(lat, lon, [{ level, radiusM: radiusM * Math.SQRT2 }], onProgress);
      if (id !== this.request) return null;
    }
    const slopeAt = polar
      ? (la: number, lo: number) => {
          const p = polarPixel(m!, la, lo);
          return dem!.pixelValue(level, Math.round(toLevel(p.line, level)), Math.round(toLevel(p.sample, level)));
        }
      : (la: number, lo: number) => coarseSlopeDeg(coarse!, la, lo);
    this.object.material.uniforms.coarse.value = polar ? 0 : 1;

    // Local frame at the centre: square of side 2r in (east, north) km; the shader keeps the
    // inscribed disc. Points placed by great-circle distance + bearing (azimuthal equidistant).
    const frame = localFrame(lat, lon);
    const r = radiusKm;
    const tex = new Float32Array(TEX * TEX);
    for (let j = 0; j < TEX; j++)
      for (let i = 0; i < TEX; i++) {
        const p = frame.at(-r + ((i + 0.5) / TEX) * 2 * r, -r + ((j + 0.5) / TEX) * 2 * r);
        const v = slopeAt(p.lat, p.lon);
        tex[j * TEX + i] = Number.isNaN(v) ? -1 : v;
      }
    const slopeTex = new THREE.DataTexture(tex, TEX, TEX, THREE.RedFormat, THREE.FloatType);
    slopeTex.magFilter = THREE.NearestFilter; // no blending across the threshold / no-data
    slopeTex.minFilter = THREE.NearestFilter;
    slopeTex.generateMipmaps = false;
    slopeTex.flipY = false;
    slopeTex.needsUpdate = true;

    const n = GRID + 1;
    const pos = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    const huv = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const p = frame.at(-r + (i / GRID) * 2 * r, -r + (j / GRID) * 2 * r);
        const u = latLonToUnit(p.lat, p.lon);
        pos.set([u.x, u.y, u.z], 3 * k);
        uv.set([i / GRID, j / GRID], 2 * k);
        // Height raster: equirectangular, u = (lon + 180) / 360, v = (lat + 90) / 180 (row 0 = south).
        huv.set([(p.lon + 180) / 360, (p.lat + 90) / 180], 2 * k);
      }
    const index: number[] = [];
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        // i = east, j = north: (a, east, north) is counter-clockwise seen from outside the Moon
        // (front face; FrontSide culling hides the other winding).
        const a = j * n + i;
        index.push(a, a + 1, a + n, a + 1, a + n + 1, a + n);
      }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geometry.setAttribute("huv", new THREE.BufferAttribute(huv, 2));
    geometry.setIndex(index);

    this.object.geometry.dispose();
    this.object.geometry = geometry;
    this.slopeTex?.dispose();
    this.slopeTex = slopeTex;
    this.object.material.uniforms.slopeTex.value = slopeTex;
    this.object.visible = true;
    return base;
  }

  setMaxSlope(deg: number): void {
    this.object.material.uniforms.maxSlope.value = deg;
  }

  /** km → scene units (exaggeration included), as Globe.scale. */
  setScale(scale: number): void {
    const u = this.object.material.uniforms;
    u.scale.value = scale;
    u.lift.value = Math.max(LIFT_MIN, LIFT_KM * scale);
  }

  dispose(): void {
    this.request++;
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.slopeTex?.dispose();
  }
}
