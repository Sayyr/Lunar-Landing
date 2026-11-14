// loaders.js — téléchargement des données avec progression.

import { fromArrayBuffer } from 'geotiff';
import { Heightmap, flipRowsInPlace } from './heightmap.js';

/**
 * fetch() avec rapport de progression (octets reçus / total).
 * `onProgress(fraction|null)` : null si le serveur n'envoie pas Content-Length
 * (ou s'il compresse la réponse, auquel cas Content-Length ne correspond pas au corps).
 */
export async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const encoded = res.headers.get('Content-Encoding');
  if (!res.body || !total || encoded) {
    onProgress?.(null);
    const buf = await res.arrayBuffer();
    onProgress?.(1);
    return buf;
  }
  const out = new Uint8Array(total); // tampon unique, rempli au fil de l'eau
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > total) throw new Error(`${url} : taille inattendue`);
    out.set(value, received);
    received += value.length;
    onProgress?.(received / total);
  }
  return out.buffer;
}

/**
 * Charge un ldem_*.tif et retourne un Heightmap.
 * Mémoire : le fichier est téléchargé d'un bloc (évite les centaines de requêtes Range de
 * geotiff.fromUrl sur un TIFF à une ligne par bande), décodé en un Float32Array, puis le
 * tampon du fichier est relâché. En régime permanent il ne reste qu'une copie CPU du raster,
 * partagée entre la DataTexture (envoyée au GPU) et les lectures d'altitude.
 */
export async function loadHeightmap(url, label, onProgress) {
  let buffer = await fetchWithProgress(url, onProgress);
  const tiff = await fromArrayBuffer(buffer);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const [band] = await image.readRasters({ interleave: false });
  buffer = null; // plus de référence au fichier brut : récupérable par le GC
  if (!(band instanceof Float32Array)) {
    throw new Error(`${label} : float32 attendu, reçu ${band?.constructor?.name}`);
  }
  if (width !== height * 2) {
    throw new Error(`${label} : raster équirectangulaire 2:1 attendu, reçu ${width}×${height}`);
  }
  flipRowsInPlace(band, width, height);
  return new Heightmap(band, width, height, label);
}

/** Charge une image (JPEG) avec progression et retourne un HTMLImageElement décodé. */
export async function loadImage(url, onProgress) {
  const buf = await fetchWithProgress(url, onProgress);
  const blobUrl = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
  try {
    const img = new Image();
    img.src = blobUrl;
    await img.decode();
    return img;
  } finally {
    // L'image décodée reste utilisable après révocation de l'URL.
    URL.revokeObjectURL(blobUrl);
  }
}

export async function loadJson(url, onProgress) {
  const buf = await fetchWithProgress(url, onProgress);
  return JSON.parse(new TextDecoder().decode(buf));
}
