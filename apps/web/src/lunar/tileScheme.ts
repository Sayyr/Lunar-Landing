// Tile pyramid of the NASA Moon Trek WMTS layer "LRO_WAC_Mosaic_Global_303ppd_v02" (pure, testable).
//
// Checked against its WMTSCapabilities.xml (2026-11-14): equirectangular (EQ), TileMatrixSet
// "default028mm", 256 × 256 JPEG tiles, top-left corner (−180°, +90°), level z = 2^(z+1) × 2^z
// tiles, levels 0…10. The mosaic itself is 303 px/° (≈ 100 m/px): levels above 8 only upsample.
// Longitude east-positive, planetocentric latitude, same convention as the rest of lunar/.

export const TREK_LAYER = "LRO_WAC_Mosaic_Global_303ppd_v02";
export const TREK_TILE_URL = `https://trek.nasa.gov/tiles/Moon/EQ/${TREK_LAYER}/1.0.0/default/default028mm`;
export const TILE_PX = 256;
/** Deepest level with real data (level 8 ≈ 364 px/° ≥ 303 px/°). */
export const MAX_LEVEL = 8;

export interface TileId {
  z: number;
  row: number;
  col: number;
}

export interface TileBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

/** Tile edge length in degrees (same in latitude and longitude). */
export const tileSpanDeg = (z: number) => 180 / 2 ** z;

/** Pixels per degree of a level. */
export const levelPxPerDeg = (z: number) => TILE_PX / tileSpanDeg(z);

export function tileBounds({ z, row, col }: TileId): TileBounds {
  const s = tileSpanDeg(z);
  const west = -180 + col * s;
  const north = 90 - row * s;
  return { west, east: west + s, south: north - s, north };
}

/**
 * Affine map from a tile's local UV (0..1, v = 0 at its south edge) to the global equirectangular
 * UV of the LOLA raster texture (u = (lon + 180) / 360, v = (lat + 90) / 180, rows south → north):
 * global = offset + local × scale.
 */
export function tileToGlobalUv(id: TileId): { scaleU: number; scaleV: number; offsetU: number; offsetV: number } {
  const b = tileBounds(id);
  return {
    scaleU: (b.east - b.west) / 360,
    scaleV: (b.north - b.south) / 180,
    offsetU: (b.west + 180) / 360,
    offsetV: (b.south + 90) / 180,
  };
}

export function tileUrl({ z, row, col }: TileId): string {
  return `${TREK_TILE_URL}/${z}/${row}/${col}.jpg`;
}

export const tileKey = ({ z, row, col }: TileId) => `${z}/${row}/${col}`;

export function rootTiles(): TileId[] {
  return [
    { z: 0, row: 0, col: 0 },
    { z: 0, row: 0, col: 1 },
  ];
}

export function childTiles({ z, row, col }: TileId): TileId[] {
  return [
    { z: z + 1, row: 2 * row, col: 2 * col },
    { z: z + 1, row: 2 * row, col: 2 * col + 1 },
    { z: z + 1, row: 2 * row + 1, col: 2 * col },
    { z: z + 1, row: 2 * row + 1, col: 2 * col + 1 },
  ];
}

/** First level that is sharper than a global base texture `basePx` pixels wide. */
export function firstUsefulLevel(basePx: number): number {
  let z = 0;
  while (levelPxPerDeg(z) <= basePx / 360 && z < MAX_LEVEL) z++;
  return z;
}
