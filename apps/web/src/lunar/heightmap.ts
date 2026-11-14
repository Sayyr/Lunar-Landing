// CPU access to the LOLA elevation raster (NASA SVS CGI Moon Kit, ldem_*.tif).
// Ported from apps/moon-explorer/js/heightmap.js. Pure module (no three.js).
//
// Source format (checked on ldem_4.tif): uncompressed float32 TIFF, one band, values in km
// relative to a 1737.4 km sphere, row 0 = north (+90°), column 0 = west edge at −180°,
// "area" pixels (centre of pixel i at −180 + (i + 0.5)·360/W).
// NB: not a GeoTIFF in the strict sense (no GeoKeys); the georeferencing above comes from the
// CGI Moon Kit documentation and was checked on the extremes (highest point ≈ 5.4° N 158.6° W,
// +10.5 km).

import { MOON_RADIUS_KM } from "./geo";

/**
 * Reverses row order IN PLACE (no copy of the full raster). Afterwards row 0 = south, which is
 * what a three.js DataTexture expects (flipY = false: row 0 sits at v = 0, the SphereGeometry
 * south pole).
 */
export function flipRowsInPlace(data: Float32Array, width: number, height: number): void {
  const tmp = new Float32Array(width); // one-row buffer
  for (let top = 0, bot = height - 1; top < bot; top++, bot--) {
    const a = top * width;
    const b = bot * width;
    tmp.set(data.subarray(a, a + width));
    data.copyWithin(a, b, b + width);
    data.set(tmp, b);
  }
}

export class Heightmap {
  /** Range of the data; extended by `extendRange()` as streamed bands arrive. */
  minKm: number;
  maxKm: number;
  /** Approximate resolution at the equator (km per pixel). */
  readonly kmPerPixel: number;

  /**
   * @param data   raster in km, rows already flipped (row 0 = south)
   * @param label  product name (e.g. "ldem_16")
   */
  constructor(
    readonly data: Float32Array,
    readonly width: number,
    readonly height: number,
    public label = "",
  ) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const h = data[i];
      if (h < min) min = h;
      if (h > max) max = h;
    }
    this.minKm = min;
    this.maxKm = max;
    this.kmPerPixel = (2 * Math.PI * MOON_RADIUS_KM) / width;
  }

  /** Widens minKm/maxKm with rows [row0, row0 + rows) (after they were overwritten in place). */
  extendRange(row0: number, rows: number): void {
    const end = (row0 + rows) * this.width;
    for (let i = row0 * this.width; i < end; i++) {
      const h = this.data[i];
      if (h < this.minKm) this.minKm = h;
      if (h > this.maxKm) this.maxKm = h;
    }
  }

  /**
   * Bilinear resampling of the whole raster to width × height (same geometry: area pixels,
   * longitude wrap, latitude clamp — identical to sampleKm at each target pixel centre).
   * Used to start a high-resolution array from a coarse product while the real one streams in.
   */
  resampled(width: number, height: number): Float32Array {
    const { width: sw, height: sh, data } = this;
    const out = new Float32Array(width * height);
    const xa = new Int32Array(width);
    const xb = new Int32Array(width);
    const fx = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const s = ((x + 0.5) * sw) / width - 0.5;
      const x0 = Math.floor(s);
      fx[x] = s - x0;
      xa[x] = ((x0 % sw) + sw) % sw;
      xb[x] = (xa[x] + 1) % sw;
    }
    for (let y = 0; y < height; y++) {
      const s = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / height - 0.5));
      const y0 = Math.min(sh - 2, Math.floor(s));
      const fy = s - y0;
      const r0 = y0 * sw;
      const r1 = r0 + sw;
      const o = y * width;
      for (let x = 0; x < width; x++) {
        const top = data[r0 + xa[x]] * (1 - fx[x]) + data[r0 + xb[x]] * fx[x];
        const bot = data[r1 + xa[x]] * (1 - fx[x]) + data[r1 + xb[x]] * fx[x];
        out[o + x] = top * (1 - fy) + bot * fy;
      }
    }
    return out;
  }

  /**
   * Elevation in km by bicubic (Catmull-Rom) interpolation: passes through the pixel values like
   * sampleKm, but with a continuous slope, so shading of a finely meshed surface does not show
   * the raster's pixel edges (stair steps). Same wrap/clamp rules. Visualization use.
   */
  sampleKmSmooth(lat: number, lon: number): number {
    const { width: W, height: H, data } = this;
    const x = ((lon + 180) / 360) * W - 0.5;
    const y = Math.min(H - 1, Math.max(0, ((lat + 90) / 180) * H - 0.5));
    const x1 = Math.floor(x);
    const y1 = Math.min(H - 2, Math.floor(y));
    const tx = x - x1;
    const ty = y - y1;
    const col = (i: number) => (((x1 + i) % W) + W) % W;
    const row = (j: number) => Math.min(H - 1, Math.max(0, y1 + j)) * W;
    const cr = (p0: number, p1: number, p2: number, p3: number, t: number) =>
      p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
    const c0 = col(-1), c1 = col(0), c2 = col(1), c3 = col(2);
    const rowVal = (j: number) => {
      const r = row(j);
      return cr(data[r + c0], data[r + c1], data[r + c2], data[r + c3], tx);
    };
    return cr(rowVal(-1), rowVal(0), rowVal(1), rowVal(2), ty);
  }

  /**
   * Elevation in km by bilinear interpolation (matches GPU linear filtering): longitude wraps
   * (seamless at ±180°), latitude is clamped to the outermost rows.
   */
  sampleKm(lat: number, lon: number): number {
    const { width: W, height: H, data } = this;
    const x = ((lon + 180) / 360) * W - 0.5;
    const y = ((lat + 90) / 180) * H - 0.5; // row 0 = south after flipping
    const x0 = Math.floor(x);
    const fx = x - x0;
    const yc = Math.min(H - 1, Math.max(0, y));
    const y0 = Math.min(H - 2, Math.floor(yc));
    const fy = yc - y0;
    const xa = ((x0 % W) + W) % W;
    const xb = (xa + 1) % W;
    const r0 = y0 * W;
    const r1 = r0 + W;
    const top = data[r0 + xa] * (1 - fx) + data[r0 + xb] * fx;
    const bot = data[r1 + xa] * (1 - fx) + data[r1 + xb] * fx;
    return top * (1 - fy) + bot * fy;
  }
}
