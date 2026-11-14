// Ground colour for the ground view from the LROC WAC colour mosaic (real data, ≈ 2.7 km/px).
//
// The mosaic's mean brightness is mapped to a regolith grey (MEAN_TARGET) and, because the WAC
// colour product is contrast-enhanced, only SATURATION of its tint is kept: the ground reads grey
// with a faint real hue, as seen by eye. Pre-baked once into an RGB table, so sampling is three
// loads (no per-vertex arithmetic or allocation).

import type { ColorSource } from "./groundTerrain";

const MEAN_TARGET = 0.62;
const SATURATION = 0.35;

/** Pure part: RGBA8 equirectangular pixels (row 0 = north, column 0 = −180°) → ColorSource. */
export function colorSourceFromPixels(px: Uint8ClampedArray | Uint8Array, W: number, H: number): ColorSource {
  let mean = 0;
  for (let i = 0; i < px.length; i += 4) mean += px[i] + px[i + 1] + px[i + 2];
  mean /= (px.length / 4) * 3 * 255;
  const k = MEAN_TARGET / mean;
  const rgb = new Float32Array(W * H * 3);
  for (let p = 0; p < W * H; p++) {
    const [r, g, b] = [(px[4 * p] / 255) * k, (px[4 * p + 1] / 255) * k, (px[4 * p + 2] / 255) * k];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    rgb[3 * p] = Math.min(1, l + SATURATION * (r - l));
    rgb[3 * p + 1] = Math.min(1, l + SATURATION * (g - l));
    rgb[3 * p + 2] = Math.min(1, l + SATURATION * (b - l));
  }
  return (lat, lon, out, offset) => {
    const x = Math.min(W - 1, Math.max(0, Math.floor(((lon + 180) / 360) * W)));
    const y = Math.min(H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * H)));
    const i = 3 * (y * W + x);
    out[offset] = rgb[i];
    out[offset + 1] = rgb[i + 1];
    out[offset + 2] = rgb[i + 2];
  };
}

/** Browser part: reads the mosaic once at 2048 × 1024 (one table per image, the pixels are dropped). */
const cache = new WeakMap<HTMLImageElement, ColorSource>();
export function colorSourceFromImage(img: HTMLImageElement | null): ColorSource | undefined {
  if (!img) return undefined;
  let source = cache.get(img);
  if (source) return source;
  const W = 2048;
  const H = 1024;
  const ctx = Object.assign(document.createElement("canvas"), { width: W, height: H }).getContext("2d", { willReadFrequently: true });
  if (!ctx) return undefined;
  ctx.drawImage(img, 0, 0, W, H);
  source = colorSourceFromPixels(ctx.getImageData(0, 0, W, H).data, W, H);
  cache.set(img, source);
  return source;
}
