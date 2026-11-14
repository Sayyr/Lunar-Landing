// Procedural regolith detail for the ground view: ILLUSTRATIVE surface grain, not data.
//
// No lunar product resolves the centimetre-to-metre texture an observer sees at their feet, so
// this generates a tileable patch (deterministic seed): multi-octave value noise for grain and
// albedo mottling, plus small bowl-shaped craters with raised rims drawn into a height field
// (craters ARE height, not painted shading — the scene's Sun lights them). Used as an albedo
// multiplier and a bump map, sampled at several scales in the shader so the repeat is not seen.

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Periodic value noise on a size × size grid: lattice of `cells` × `cells` random values, smooth
 * (quintic) interpolation, wraps at the edges, so the patch tiles seamlessly. Values in [0, 1].
 */
export function periodicNoise(size: number, cells: number, rand: () => number): Float32Array {
  const lat = Float32Array.from({ length: cells * cells }, rand);
  const out = new Float32Array(size * size);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let y = 0; y < size; y++) {
    const gy = (y / size) * cells;
    const y0 = Math.floor(gy);
    const ty = fade(gy - y0);
    const r0 = (y0 % cells) * cells;
    const r1 = ((y0 + 1) % cells) * cells;
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * cells;
      const x0 = Math.floor(gx);
      const tx = fade(gx - x0);
      const c0 = x0 % cells;
      const c1 = (x0 + 1) % cells;
      const top = lat[r0 + c0] * (1 - tx) + lat[r0 + c1] * tx;
      const bot = lat[r1 + c0] * (1 - tx) + lat[r1 + c1] * tx;
      out[y * size + x] = top * (1 - ty) + bot * ty;
    }
  }
  return out;
}

export interface RegolithFields {
  size: number;
  /** relative height, roughly [0, 1] (source of the normal map) */
  height: Float32Array;
  /** albedo multiplier around 1 (mottling + bright fresh-crater halos) */
  albedo: Float32Array;
  /** PBR roughness, 0.85–1 (regolith is very matte; slightly smoother on fresh ejecta) */
  roughness: Float32Array;
}

/**
 * Tangent-space normal map (RGB 0..1, +Z out of the surface) from a periodic height field:
 * central differences with wrap-around, so it tiles like the height. `strength` scales the
 * slopes (height units per pixel → normal tilt).
 */
export function normalsFromHeight(height: Float32Array, size: number, strength: number): Float32Array {
  const out = new Float32Array(size * size * 3);
  const at = (x: number, y: number) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = 3 * (y * size + x);
      out[i] = 0.5 - (0.5 * dx) / len;
      out[i + 1] = 0.5 - (0.5 * dy) / len;
      out[i + 2] = 0.5 + 0.5 / len;
    }
  return out;
}

/** Height and albedo fields of one tileable regolith patch. */
export function regolithFields(size = 512, seed = 7): RegolithFields {
  const rand = rng(seed);
  const height = new Float32Array(size * size);
  const albedo = new Float32Array(size * size).fill(1);
  const roughness = new Float32Array(size * size);
  // fBm grain: coarse lumps to fine grit.
  const octaves: [number, number][] = [[4, 0.5], [8, 0.25], [16, 0.13], [32, 0.07], [64, 0.05]];
  for (const [cells, amp] of octaves) {
    const n = periodicNoise(size, cells, rand);
    for (let i = 0; i < n.length; i++) height[i] += amp * n[i];
  }
  const mottle = periodicNoise(size, 6, rand);
  for (let i = 0; i < albedo.length; i++) albedo[i] = 0.82 + 0.3 * mottle[i] + 0.25 * (height[i] - 0.5);
  const rough = periodicNoise(size, 12, rand);
  for (let i = 0; i < roughness.length; i++) roughness[i] = 0.88 + 0.12 * rough[i];

  // Craters: power-law sizes (many small, few large), bowl + raised rim, wrapped at the edges.
  const n = 70;
  for (let k = 0; k < n; k++) {
    const r = size * (0.012 + 0.09 * rand() ** 3); // radius in pixels
    const cx = rand() * size;
    const cy = rand() * size;
    const depth = 0.25 * (r / size) * 6;
    const fresh = rand() < 0.15; // a few bright, fresh ones
    const R = Math.ceil(r * 1.8);
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dy) / r;
        if (d > 1.8) continue;
        const x = (((Math.round(cx + dx) % size) + size) % size);
        const y = (((Math.round(cy + dy) % size) + size) % size);
        const i = y * size + x;
        // Bowl inside (−), rim around d ≈ 1 (+), fading ejecta outside.
        const h = d < 1 ? -depth * (1 - d * d) + 0.35 * depth * d ** 6 : 0.35 * depth * Math.exp(-(((d - 1) / 0.25) ** 2));
        height[i] += h;
        if (fresh && d < 1.8) {
          albedo[i] += 0.18 * (1 - d / 1.8);
          roughness[i] = Math.max(0.85, roughness[i] - 0.06 * (1 - d / 1.8));
        }
      }
  }
  return { size, height, albedo, roughness };
}
