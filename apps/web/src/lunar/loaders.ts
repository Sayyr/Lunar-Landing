// Data download with progress (ported from apps/moon-explorer/js/loaders.js).

import { fromArrayBuffer } from "geotiff";

import { flipRowsInPlace, Heightmap } from "./heightmap";

export type Progress = (fraction: number | null) => void;

/** Where scripts/setup-data.sh installs the NASA/IAU data (git-ignored), and how to get it. */
export const DATA_BASE = `${import.meta.env.BASE_URL}data/`;
export const SETUP_HINT = "run apps/web/scripts/setup-data.sh";

/**
 * fetch() reporting progress. Content-Length is only a progress hint: it is absent, or doesn't match
 * the body, when the response is compressed (and CORS can hide Content-Encoding). `onProgress(null)`
 * means "indeterminate".
 */
export async function fetchWithProgress(url: string, onProgress?: Progress): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  // Vite's dev server answers unknown paths with index.html (200): reject that explicitly.
  if ((res.headers.get("Content-Type") ?? "").startsWith("text/html")) throw new Error(`${url}: not found`);
  const total = res.headers.get("Content-Encoding") ? 0 : Number(res.headers.get("Content-Length")) || 0;
  if (!res.body) return res.arrayBuffer();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(total && received <= total ? received / total : null);
  }
  if (total && received < total) throw new Error(`${url}: truncated (${received} of ${total} bytes)`);
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  onProgress?.(1);
  return out.buffer;
}

/**
 * Loads an ldem_*.tif into a Heightmap.
 * Memory: the file is downloaded in one piece (avoids hundreds of Range requests from
 * geotiff.fromUrl on a one-row-per-strip TIFF), decoded into one Float32Array, then the file
 * buffer is released. In steady state only one CPU copy remains, shared between the DataTexture
 * (uploaded to the GPU) and elevation lookups.
 */
export async function loadHeightmap(url: string, label: string, onProgress?: Progress): Promise<Heightmap> {
  const buffer = await fetchWithProgress(url, onProgress);
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const rasters = await image.readRasters({ interleave: false });
  const band = (rasters as unknown as ArrayLike<unknown>[])[0];
  if (!(band instanceof Float32Array)) {
    throw new Error(`${label}: float32 expected, got ${(band as object | undefined)?.constructor?.name}`);
  }
  if (width !== height * 2) {
    throw new Error(`${label}: 2:1 equirectangular raster expected, got ${width}×${height}`);
  }
  flipRowsInPlace(band, width, height);
  return new Heightmap(band, width, height, label);
}

/** Manifest written by scripts/split_ldem.py next to the band files. */
export interface BandManifest {
  source: string;
  width: number;
  height: number;
  dtype: "float32le";
  bands: { file: string; row0: number; rows: number; bytes: number }[];
}

/**
 * Streams the bands of a split raster into `target` (row-major, south-first, already sized
 * manifest.width × manifest.height), `concurrency` downloads at a time, in the given order.
 * `onBand(row0, rows)` runs after each band is written in place. Resolves with the number of
 * bands loaded; a failed band is skipped (its rows keep their previous values).
 */
export async function streamBands(
  base: string,
  manifest: BandManifest,
  target: Float32Array,
  order: number[],
  onBand: (row0: number, rows: number) => void,
  concurrency = 3,
  signal?: { cancelled: boolean },
): Promise<number> {
  if (manifest.dtype !== "float32le") throw new Error(`unsupported band dtype ${manifest.dtype}`);
  const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  if (!littleEndian) throw new Error("big-endian platform: float32le bands not supported");
  let next = 0;
  let loaded = 0;
  const worker = async () => {
    while (next < order.length && !signal?.cancelled) {
      const band = manifest.bands[order[next++]];
      try {
        const res = await fetch(`${base}${band.file}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        if (buf.byteLength !== band.rows * manifest.width * 4) throw new Error("unexpected size");
        if (signal?.cancelled) return;
        target.set(new Float32Array(buf), band.row0 * manifest.width);
        loaded++;
        onBand(band.row0, band.rows);
      } catch (e) {
        console.warn(`elevation band ${band.file} skipped:`, e);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return loaded;
}

/** Band indices sorted by distance of their centre latitude to `lat` (nearest first). */
export function bandOrderNear(manifest: BandManifest, lat: number): number[] {
  const centre = (b: { row0: number; rows: number }) => ((b.row0 + b.rows / 2) / manifest.height) * 180 - 90;
  return manifest.bands.map((_, i) => i).sort((a, b) => Math.abs(centre(manifest.bands[a]) - lat) - Math.abs(centre(manifest.bands[b]) - lat));
}

/** Loads an image (JPEG/PNG) with progress and returns a decoded HTMLImageElement. */
export async function loadImage(url: string, onProgress?: Progress): Promise<HTMLImageElement> {
  const buf = await fetchWithProgress(url, onProgress);
  const blobUrl = URL.createObjectURL(new Blob([buf]));
  try {
    const img = new Image();
    img.src = blobUrl;
    await img.decode();
    return img;
  } finally {
    // The decoded image stays usable after the URL is revoked.
    URL.revokeObjectURL(blobUrl);
  }
}

export async function loadJson<T>(url: string, onProgress?: Progress): Promise<T> {
  const buf = await fetchWithProgress(url, onProgress);
  return JSON.parse(new TextDecoder().decode(buf)) as T;
}
