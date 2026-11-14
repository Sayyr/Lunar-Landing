import { describe, expect, it } from "vitest";

import { LANDING_SITES, landingLabel, nearestLandingSite } from "./landingSites";

describe("landing sites (LROC table)", () => {
  it("are in the public convention: lat in [-90, 90], lon in [-180, 180), soft landings only", () => {
    expect(LANDING_SITES.length).toBeGreaterThan(20);
    for (const s of LANDING_SITES) {
      expect(Math.abs(s.lat)).toBeLessThanOrEqual(90);
      expect(s.lon).toBeGreaterThanOrEqual(-180);
      expect(s.lon).toBeLessThan(180);
      expect(s.date_utc).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(LANDING_SITES.some((s) => /impact/i.test(s.mission + s.id))).toBe(false);
  });

  it("flags the six Apollo landings as crewed", () => {
    expect(LANDING_SITES.filter((s) => s.crewed).map((s) => s.mission)).toEqual([
      "Apollo 11", "Apollo 12", "Apollo 14", "Apollo 15", "Apollo 16", "Apollo 17",
    ]);
  });

  it("finds the closest site within the radius only", () => {
    const a11 = LANDING_SITES.find((s) => s.id === "A11_LM")!;
    const hit = nearestLandingSite(a11.lat + 0.01, a11.lon, 1); // ≈ 0.3 km north
    expect(hit?.site.id).toBe("A11_LM");
    expect(hit?.distanceKm).toBeCloseTo(0.303, 2);
    expect(nearestLandingSite(a11.lat + 1, a11.lon, 1)).toBeNull();
  });

  it("names the vehicle only when it adds information", () => {
    expect(landingLabel(LANDING_SITES.find((s) => s.id === "A11_LM")!)).toBe("Apollo 11 (Eagle) · landed 1969-07-20");
    expect(landingLabel(LANDING_SITES.find((s) => s.id === "Surveyor1")!)).toBe("Surveyor 1 · landed 1966-05-30");
    expect(landingLabel(LANDING_SITES.find((s) => s.id === "Luna16")!)).toBe("Luna 16 · landed 1970-09-12");
  });
});
