// The derived LOLA 20 m slope product (services/science/tools/slope_tiles.cpp →
// public/data/polar_s_slope/), opened ONCE per page: the side-panel slope map and the globe slope
// disc share this PolarDem, so each tile is fetched and held in memory a single time.

import { DATA_BASE, loadJson } from "./loaders";
import { PolarDem, type PolarManifest } from "./polarDem";

export const SLOPE_BASE = `${DATA_BASE}polar_s_slope/`;

/** Fields of polar_s_slope/manifest.json used besides the tile geometry shared with polar_s. */
export interface SlopeExtra {
  status: string;
  method: { baseline_m: number };
  source: { product_id?: string };
}

export type SlopeManifest = Omit<PolarManifest, "source"> & SlopeExtra;

export interface SlopeProduct {
  /** slope tiles (degrees), read with PolarDem.pixelValue */
  dem: PolarDem;
  manifest: SlopeManifest;
  productId: string;
}

let promise: Promise<SlopeProduct | null> | null = null;

/** The slope product, or null when its tiles are not installed (manifest missing / unreadable). */
export function loadSlopeProduct(): Promise<SlopeProduct | null> {
  return (promise ??= loadJson<SlopeManifest>(`${SLOPE_BASE}manifest.json`)
    .then((m) => ({
      // PolarDem only reads the tile geometry (projection, tile, levels).
      dem: new PolarDem(m as unknown as PolarManifest, `${SLOPE_BASE}slope/`),
      manifest: m,
      productId: m.source?.product_id ?? "LOLA polar DEM",
    }))
    .catch(() => null));
}
