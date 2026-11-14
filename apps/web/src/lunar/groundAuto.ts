// Is the Sun above the terrain seen from a site? (pure)
// Uses the rendered terrain's horizon (groundTerrain.horizonAt): a visual estimate, not the
// science service's illumination computation.

import { type GroundTerrain, horizonAt } from "./groundTerrain";
import type { AzEl } from "./skyGeometry";

/** Sun's angular radius seen from the Moon (degrees): "clears" = whole disc above the terrain. */
export const SUN_RADIUS_DEG = 0.27;

export function sunClearsTerrain(sun: AzEl, terrain: GroundTerrain, marginDeg = SUN_RADIUS_DEG): boolean {
  return sun.elevationDeg - horizonAt(terrain, sun.azimuthDeg) > marginDeg;
}
