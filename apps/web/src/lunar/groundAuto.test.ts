import { describe, expect, it } from "vitest";

import { sunClearsTerrain } from "./groundAuto";
import { buildGroundTerrain, heightmapSource } from "./groundTerrain";

const opt = { bearings: 72, rings: 40, minDistanceM: 5, maxDistanceM: 400_000 };

describe("sunClearsTerrain", () => {
  const t = buildGroundTerrain(heightmapSource(null), 0, 0, 2, opt); // smooth sphere: horizon just below 0°
  it("whole disc above the terrain horizon", () => {
    expect(sunClearsTerrain({ azimuthDeg: 90, elevationDeg: 1 }, t)).toBe(true);
    expect(sunClearsTerrain({ azimuthDeg: 90, elevationDeg: 0.1 }, t)).toBe(false); // disc not fully up
    expect(sunClearsTerrain({ azimuthDeg: 90, elevationDeg: -2 }, t)).toBe(false);
  });
});
