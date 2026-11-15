import { describe, expect, it } from "vitest";

import { LANDING_SITES } from "../lunar/landingSites";
import { buildMissionRequest } from "./mission";
import { MISSION_PRESETS } from "./missionPresets";

describe("mission presets", () => {
  it("Chandrayaan-3 uses the LROC site and the real landing → sleep window", () => {
    const p = MISSION_PRESETS.find((x) => x.id === "chandrayaan3-vikram")!;
    const v = LANDING_SITES.find((s) => s.id === "Vikram2")!;
    expect(p.scenario.site).toMatchObject({ latitude_deg: v.lat, longitude_deg: v.lon });
    expect(p.scenario.start_utc).toBe("2023-08-23T12:33:00Z");
    expect(p.scenario.duration_hours).toBeCloseTo(277.95, 2); // → 2023-09-04T02:30Z
    expect(p.scenario.terrain_mode).toBe("ideal"); // outside the 85°S DEM
    // peak array output = published 738 W
    expect(p.settings.power).toBeNull(); // energy optional, off by default
    const pw = p.powerValues!;
    expect(1361 * pw.panel_area_m2 * pw.panel_efficiency).toBeCloseTo(738, 9);
  });

  it("every preset builds a request and cites every fact", () => {
    for (const p of MISSION_PRESETS) {
      const r = buildMissionRequest(p.scenario, p.settings);
      expect(r.surface_hours).toBeGreaterThan(0);
      expect(p.facts.length).toBeGreaterThan(0);
      for (const f of p.facts) expect(f.url).toMatch(/^https:\/\//);
      expect(p.assumed.length).toBeGreaterThan(0); // unpublished values are always declared
    }
  });
});
