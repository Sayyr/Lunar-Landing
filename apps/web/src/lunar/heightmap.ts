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
  readonly minKm: number;
  readonly maxKm: number;
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
    readonly label = "",
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
