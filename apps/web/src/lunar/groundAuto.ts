// Is the Sun above the terrain seen from a site? (pure)
// Uses the rendered terrain's horizon (groundTerrain.horizonAt): a visual estimate, not the
// science service's illumination computation.

import { AU_M, DEG, SUN_RADIUS_M } from "../lib/constants";
import { type GroundTerrain, horizonAt } from "./groundTerrain";
import type { AzEl } from "./skyGeometry";

/** Mean angular radius of the Sun seen from the Moon (≈ 0.27°), radians. Also used to draw it. */
export const SUN_ANG_RADIUS = Math.atan(SUN_RADIUS_M / AU_M);

/** "Clears" = the whole solar disc is above the terrain horizon in its direction. */
export function sunClearsTerrain(sun: AzEl, terrain: GroundTerrain): boolean {
  return sun.elevationDeg - horizonAt(terrain, sun.azimuthDeg) > SUN_ANG_RADIUS / DEG;
}
