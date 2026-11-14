// Bank of interconnected regolith tiles (Wang tiles) for the ground view's close-up detail.
// ILLUSTRATIVE: procedural surface below the DEM resolution, not data.
//
// Why: one repeating texture shows a grid. A Wang set has 2 "colours" per edge → 16 tiles
// (n, e, s, w ∈ {0, 1}); the shader picks each cell's tile from hashes of its four edges, so
// any two neighbours share the colour of their common edge and the surface never repeats
// periodically.
//
// How the tiles connect seamlessly: every field (height, albedo, roughness) is a variance-
// preserving blend of
//   - a base field periodic with the tile (same in every tile),
//   - one field per (edge orientation, colour), defined in edge coordinates (along, across) so
//     the two tiles sharing an edge evaluate the SAME function on both sides of it,
//   - one interior field per tile,
// with windows that vanish (with zero slope) where they must: interior → 0 on every edge, edge
// fields → 0 at the corners and beyond half a tile. Features follow the same rule: interior
// craters/boulders stay inside the tile; edge craters/boulders live in edge coordinates and are
// drawn by both tiles, so they straddle tile borders. Corners only carry the base field.
// Heights are computed with a one-pixel apron so normals are continuous across tiles too.
//
// Tile-local coordinates: x east 0→1, y north 0→1; texture row 0 = south (y = 0), like the
// ground mesh UVs (east, north) / DETAIL_PERIOD_M.

import { periodicNoise, rng } from "./regolith";

export const WANG_LAYERS = 16;

/** Layer of the tile whose north/east/south/west edges have colours n, e, s, w ∈ {0, 1}. */
export const wangLayer = (n: number, e: number, s: number, w: number) => n | (e << 1) | (s << 2) | (w << 3);

export interface WangBank {
  size: number;
  /** WANG_LAYERS × size² RGBA8: RGB albedo (grey, sRGB), A roughness */
  albedoRough: Uint8Array;
  /** WANG_LAYERS × size² RGBA8: RGB tangent-space normal, A = 255 */
  normal: Uint8Array;
  /** mean albedo in LINEAR units (the shader normalises its multi-scale product with it) */
  meanLinear: number;
}

type Field = Float32Array; // size × size, periodic noise image

interface Crater {
  x: number;
  y: number;
  r: number;
  depth: number;
  rim: number;
  rimW: number;
  fresh: boolean;
}
interface Boulder {
  x: number;
  y: number;
  r: number;
  h: number;
}
interface Features {
  craters: Crater[];
  boulders: Boulder[];
}

const HEIGHT_OCTAVES: [number, number][] = [[4, 0.5], [8, 0.25], [16, 0.13], [32, 0.07], [64, 0.05]];
const BASE_WEIGHT = 0.55;
const CRATER_REACH = 1.9; // influence radius / crater radius
const NORMAL_STRENGTH = 45; // slope gain of the normal map (heights ~[0, 1] over a 512 px tile)
const FEATURE_MARGIN = 0.02; // tile units (≈ 1.3 px at 64 px, 10 px at 512)

function fbm(size: number, octaves: [number, number][], rand: () => number): Field {
  const out = new Float32Array(size * size);
  for (const [cells, amp] of octaves) {
    const n = periodicNoise(size, cells, rand);
    for (let i = 0; i < out.length; i++) out[i] += amp * n[i];
  }
  return out;
}

const sin2 = (a: number) => (a <= 0 || a >= 1 ? 0 : Math.sin(Math.PI * a) ** 2);
const cos2 = (t: number) => (Math.abs(t) >= 0.5 ? 0 : Math.cos(Math.PI * t) ** 2);
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * Craters and boulders allowed in a region: interior (whole tile, away from the edges) or an
 * edge band (along ∈ [0, 1] away from the corners, across ∈ [−0.5, 0.5] away from the far edges).
 * Coordinates are (a, b) = (x, y) for interior, (along, across) for an edge set.
 */
function features(rand: () => number, kind: "interior" | "edge", craterCount: number, boulderCount: number): Features {
  // FEATURE_MARGIN keeps every influence disc ≥ a pixel away from the edges it must not cross
  // (the neighbour tile does not know these features).
  const inside = (a: number, b: number, reach: number) => {
    const m = reach + FEATURE_MARGIN;
    return a - m >= 0 && a + m <= 1 && (kind === "interior" ? b - m >= 0 && b + m <= 1 : Math.abs(b) + m <= 0.5);
  };
  const craters: Crater[] = [];
  for (let k = 0, tries = 0; k < craterCount && tries < craterCount * 20; tries++) {
    const r = 0.006 + 0.08 * rand() ** 3.2;
    const a = rand();
    const b = kind === "interior" ? rand() : rand() - 0.5;
    if (!inside(a, b, CRATER_REACH * r)) continue;
    const age = rand(); // 0 fresh … 1 degraded
    const depth = 1.5 * r * (1 - 0.75 * age);
    craters.push({ x: a, y: b, r, depth, rim: 0.35 * depth * (1 - 0.6 * age), rimW: 0.12 + 0.3 * age, fresh: age < 0.12 });
    k++;
  }
  const boulders: Boulder[] = [];
  const fresh = craters.filter((c) => c.fresh);
  for (let k = 0, tries = 0; k < boulderCount && tries < boulderCount * 20; tries++) {
    let a = rand();
    let b = kind === "interior" ? rand() : rand() - 0.5;
    if (fresh.length && rand() < 0.75) {
      const c = fresh[Math.floor(rand() * fresh.length)];
      const ang = rand() * 2 * Math.PI;
      const rr = c.r * (0.4 + 1.4 * rand());
      a = c.x + rr * Math.cos(ang);
      b = c.y + rr * Math.sin(ang);
    }
    const r = (0.6 + 2.2 * rand() ** 2) / 512; // ≈ 0.5–2.3 cm on a 4 m tile
    if (!inside(a, b, 2.2 * r)) continue;
    boulders.push({ x: a, y: b, r, h: 0.012 * r * 512 * (0.6 + 0.8 * rand()) });
    k++;
  }
  return { craters, boulders };
}

/** Moves an edge feature set into tile coordinates for one of the tile's edges. */
function placeEdge(f: Features, edge: "n" | "s" | "e" | "w"): Features {
  // (along, across) → tile (x, y) for that edge.
  const move = <T extends { x: number; y: number }>({ x: a, y: b, ...rest }: T): T =>
    ({ ...rest, ...(edge === "n" ? { x: a, y: 1 + b } : edge === "s" ? { x: a, y: b } : edge === "e" ? { x: 1 + b, y: a } : { x: b, y: a }) }) as T;
  return { craters: f.craters.map(move), boulders: f.boulders.map(move) };
}

interface Components {
  base: Field;
  edgeH: [Field, Field];
  edgeV: [Field, Field];
  interior: Field[];
  mean: number;
}

function components(size: number, octaves: [number, number][], rand: () => number): Components {
  const make = () => fbm(size, octaves, rand);
  return {
    base: make(),
    edgeH: [make(), make()],
    edgeV: [make(), make()],
    interior: Array.from({ length: WANG_LAYERS }, make),
    mean: 0.5 * octaves.reduce((s, [, a]) => s + a, 0),
  };
}

/** Per-row / per-column window weights and field indices of the apron grid (depend on size only). */
interface Axis {
  wrap: Int32Array; // index into a periodic field
  along: Int32Array; // along-edge index
  near: Int32Array; // across-edge index for the edge at 0 (south / west)
  far: Int32Array; // across-edge index for the edge at 1 (north / east)
  sin2: Float64Array; // edge window along the axis (0 at the corners)
  cos2Near: Float64Array; // band window of the edge at 0
  cos2Far: Float64Array; // band window of the edge at 1
}
const axisCache = new Map<number, Axis>();
function axis(size: number): Axis {
  let a = axisCache.get(size);
  if (a) return a;
  const S = size + 2;
  const wrap = (k: number) => ((k % size) + size) % size;
  const across = (t: number) => Math.min(size - 1, Math.max(0, Math.floor((t + 0.5) * size)));
  a = { wrap: new Int32Array(S), along: new Int32Array(S), near: new Int32Array(S), far: new Int32Array(S), sin2: new Float64Array(S), cos2Near: new Float64Array(S), cos2Far: new Float64Array(S) };
  for (let i = 0; i < S; i++) {
    const x = (i - 0.5) / size;
    a.wrap[i] = a.along[i] = wrap(Math.floor(x * size));
    a.near[i] = across(x);
    a.far[i] = across(x - 1);
    a.sin2[i] = sin2(x);
    a.cos2Near[i] = cos2(x);
    a.cos2Far[i] = cos2(x - 1);
  }
  axisCache.set(size, a);
  return a;
}

/**
 * One blended field for tile (n, e, s, w) on an (size + 2)² grid: pixel centres at
 * x = (i − 0.5) / size, i = 0 … size + 1 (one-pixel apron around the tile).
 */
function blended(c: Components, size: number, layer: number, [n, e, s, w]: number[]): Float32Array {
  const S = size + 2;
  const A = axis(size);
  const out = new Float32Array(S * S);
  const [fN, fS, fE, fW, fI] = [c.edgeH[n], c.edgeH[s], c.edgeV[e], c.edgeV[w], c.interior[layer]];
  const m = c.mean;
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const wN = A.sin2[i] * A.cos2Far[j];
      const wS = A.sin2[i] * A.cos2Near[j];
      const wE = A.sin2[j] * A.cos2Far[i];
      const wW = A.sin2[j] * A.cos2Near[i];
      const wI = A.sin2[i] * A.sin2[j];
      const num =
        BASE_WEIGHT * (c.base[A.wrap[j] * size + A.wrap[i]] - m) +
        wN * (fN[A.far[j] * size + A.along[i]] - m) +
        wS * (fS[A.near[j] * size + A.along[i]] - m) +
        wE * (fE[A.far[i] * size + A.along[j]] - m) +
        wW * (fW[A.near[i] * size + A.along[j]] - m) +
        wI * (fI[A.wrap[j] * size + A.wrap[i]] - m);
      out[j * S + i] = m + num / Math.sqrt(BASE_WEIGHT ** 2 + wN * wN + wS * wS + wE * wE + wW * wW + wI * wI);
    }
  }
  return out;
}

/** Adds craters and boulders (tile coordinates) to the apron grids. */
function stamp(f: Features, size: number, height: Float32Array, albedo: Float32Array, rough: Float32Array): void {
  const S = size + 2;
  const px = (x: number) => x * size + 0.5; // tile coord → apron grid coord (pixel centres at integers)
  const forEach = (cx: number, cy: number, reach: number, fn: (k: number, dx: number, dy: number) => void) => {
    const i0 = Math.max(0, Math.floor(px(cx - reach)));
    const i1 = Math.min(S - 1, Math.ceil(px(cx + reach)));
    const j0 = Math.max(0, Math.floor(px(cy - reach)));
    const j1 = Math.min(S - 1, Math.ceil(px(cy + reach)));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * S + i, (i - 0.5) / size - cx, (j - 0.5) / size - cy);
  };
  for (const c of f.craters)
    forEach(c.x, c.y, CRATER_REACH * c.r, (k, dx, dy) => {
      const d = Math.hypot(dx, dy) / c.r;
      if (d > CRATER_REACH) return;
      height[k] += d < 1 ? -c.depth * (1 - d * d) + c.rim * d ** 6 : c.rim * Math.exp(-(((d - 1) / c.rimW) ** 2));
      if (c.fresh) {
        const halo = Math.max(0, 1 - d / CRATER_REACH);
        albedo[k] += 0.2 * halo;
        rough[k] = Math.max(0.85, rough[k] - 0.06 * halo);
      }
    });
  for (const b of f.boulders)
    forEach(b.x, b.y, 2.2 * b.r, (k, dx, dy) => {
      const q = (dx * dx + dy * dy) / (b.r * b.r);
      height[k] += b.h * Math.exp(-q);
      albedo[k] += 0.06 * Math.exp(-q);
    });
}

interface WangContext {
  size: number;
  H: Components;
  A: Components;
  R: Components;
  interior: Features[];
  edgeH: [Features, Features];
  edgeV: [Features, Features];
}

/** All the random material of a bank (deterministic for a seed). */
export function createWangContext(size: number, seed: number): WangContext {
  const rand = rng(seed);
  const edge = (): Features => features(rand, "edge", 20, 120);
  return {
    size,
    H: components(size, HEIGHT_OCTAVES, rand),
    A: components(size, [[6, 1]], rand),
    R: components(size, [[12, 1]], rand),
    interior: Array.from({ length: WANG_LAYERS }, () => features(rand, "interior", 60, 300)),
    edgeH: [edge(), edge()],
    edgeV: [edge(), edge()],
  };
}

/** Height, albedo and roughness of tile (n, e, s, w) on the (size + 2)² apron grid. */
export function tileFields(ctx: WangContext, [n, e, s, w]: [number, number, number, number]) {
  const { size, H, A, R } = ctx;
  const layer = wangLayer(n, e, s, w);
  const colors = [n, e, s, w];
  const height = blended(H, size, layer, colors);
  const albedo = blended(A, size, layer, colors);
  const rough = blended(R, size, layer, colors);
  for (let k = 0; k < albedo.length; k++) {
    albedo[k] = 0.82 + 0.3 * albedo[k] + 0.25 * (height[k] - H.mean);
    rough[k] = 0.88 + 0.12 * rough[k];
  }
  const placed = [ctx.interior[layer], placeEdge(ctx.edgeH[n], "n"), placeEdge(ctx.edgeH[s], "s"), placeEdge(ctx.edgeV[e], "e"), placeEdge(ctx.edgeV[w], "w")];
  for (const f of placed) stamp(f, size, height, albedo, rough);
  return { height, albedo, rough };
}

/**
 * Generates the 16-tile bank. `size` must be a power of two for mipmapping; 512 px over a 4 m
 * tile ≈ 8 mm/px. Takes ~1 s for 512: run it in a worker.
 */
export function generateWangBank(size = 512, seed = 7): WangBank {
  const ctx = createWangContext(size, seed);
  const S = size + 2;
  const albedoRough = new Uint8Array(WANG_LAYERS * size * size * 4);
  const normal = new Uint8Array(WANG_LAYERS * size * size * 4);
  let meanLinear = 0;
  for (let layer = 0; layer < WANG_LAYERS; layer++) {
    const colors: [number, number, number, number] = [layer & 1, (layer >> 1) & 1, (layer >> 2) & 1, (layer >> 3) & 1];
    const { height, albedo, rough } = tileFields(ctx, colors);
    const base = layer * size * size * 4;
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const k = (j + 1) * S + (i + 1); // apron-grid index of output pixel (i, j)
        const o = base + 4 * (j * size + i);
        const a = Math.max(0, Math.min(1, albedo[k] / 1.4));
        meanLinear += srgbToLinear(a);
        albedoRough[o] = albedoRough[o + 1] = albedoRough[o + 2] = Math.round(255 * a);
        albedoRough[o + 3] = Math.round(255 * Math.max(0.85, Math.min(1, rough[k])));
        // Central differences (the apron makes them continuous across tiles); +y = north = +v.
        const dx = (height[k + 1] - height[k - 1]) * 0.5 * NORMAL_STRENGTH;
        const dy = (height[k + S] - height[k - S]) * 0.5 * NORMAL_STRENGTH;
        const len = Math.hypot(dx, dy, 1);
        normal[o] = Math.round(255 * (0.5 - (0.5 * dx) / len));
        normal[o + 1] = Math.round(255 * (0.5 - (0.5 * dy) / len));
        normal[o + 2] = Math.round(255 * (0.5 + 0.5 / len));
        normal[o + 3] = 255;
      }
  }
  return { size, albedoRough, normal, meanLinear: meanLinear / (WANG_LAYERS * size * size) };
}
