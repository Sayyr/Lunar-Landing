// Noise primitives for the procedural regolith (wangBank.ts): deterministic PRNG and periodic
// value noise. ILLUSTRATIVE surface detail, not data.

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
