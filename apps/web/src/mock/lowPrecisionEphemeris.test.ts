import { describe, expect, it } from "vitest";

import { mockCelestialState, mockMoonTrack, phaseName } from "./celestialMock";
import {
  angleBetween,
  AU_KM,
  cartesianToEcliptic,
  DEG,
  earthFixedToEcliptic,
  eclipticToCartesian,
  eclipticToEquatorial,
  gmst,
  julianDateUtc,
  type Mat3,
  moonGeocentric,
  sunGeocentric,
  type Vec3,
} from "./lowPrecisionEphemeris";


describe("time", () => {
  it("J2000 epoch", () => {
    expect(julianDateUtc(new Date("2000-01-01T12:00:00Z"))).toBeCloseTo(2451545.0, 9);
  });
  it("GMST matches Meeus example 12.a (1987-04-10 0h UT = 13h10m46.3668s)", () => {
    expect(gmst(2446895.5) / DEG).toBeCloseTo(197.693195, 4);
  });
});

describe("low-precision positions vs. published worked examples", () => {
  // Reference values from the full-theory worked examples in Meeus, Astronomical Algorithms (2nd ed.).
  // Tolerances = the low-precision formulae's stated accuracy.
  it("Moon, Meeus example 47.a (1992-04-12 0h TD)", () => {
    const m = moonGeocentric(2448724.5);
    expect(Math.abs(m.lon / DEG - 133.162655)).toBeLessThan(0.3);
    expect(Math.abs(m.lat / DEG - -3.229126)).toBeLessThan(0.2);
    expect(Math.abs(m.distKm - 368409.7)).toBeLessThan(1500);
  });
  it("Sun, Meeus example 25.a (1992-10-13 0h TD)", () => {
    const s = sunGeocentric(2448908.5);
    expect(Math.abs(s.lon / DEG - 199.90895)).toBeLessThan(0.02);
    expect(Math.abs(s.distKm / AU_KM - 0.99766)).toBeLessThan(2e-4);
    expect(s.lat).toBe(0);
  });
});

describe("vector helpers", () => {
  it("ecliptic <-> cartesian round trip", () => {
    const p = { lon: 4.0, lat: -0.3, distKm: 384_000 };
    const back = cartesianToEcliptic(eclipticToCartesian(p));
    expect(back.lon).toBeCloseTo(p.lon, 12);
    expect(back.lat).toBeCloseTo(p.lat, 12);
    expect(back.distKm).toBeCloseTo(p.distKm, 6);
  });
  it("zero vector is rejected", () => {
    expect(() => cartesianToEcliptic([0, 0, 0])).toThrow();
  });
  it("angleBetween is exact at 0 and 180 degrees", () => {
    expect(angleBetween([1, 0, 0], [5, 0, 0])).toBe(0);
    expect(angleBetween([1, 0, 0], [-2, 0, 0])).toBeCloseTo(Math.PI, 15);
    expect(angleBetween([1, 0, 0], [0, 3, 0])).toBeCloseTo(Math.PI / 2, 15);
  });
  it("ecliptic pole maps to declination 90° − ε", () => {
    const eps = 23.44 * DEG;
    const { dec } = eclipticToEquatorial({ lon: 0, lat: Math.PI / 2, distKm: 1 }, eps);
    expect(dec).toBeCloseTo(Math.PI / 2 - eps, 12);
  });
  it("Earth orientation matrix is orthonormal", () => {
    const m = earthFixedToEcliptic(2461000.3, 2461000.3);
    const rows: Vec3[] = [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const dot = rows[i][0] * rows[j][0] + rows[i][1] * rows[j][1] + rows[i][2] * rows[j][2];
        expect(dot).toBeCloseTo(i === j ? 1 : 0, 12);
      }
  });
});

function transposeMul(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

describe("mock celestial state", () => {
  it("is always labelled synthetic", () => {
    const s = mockCelestialState(new Date("2026-11-15T00:00:00Z"));
    expect(s.status).toBe("synthetic");
    expect(s.synthetic).toBe(true);
    expect(s.warnings[0]).toMatch(/SYNTHETIC/);
  });

  it("public units are degrees and metres", () => {
    const s = mockCelestialState(new Date("2026-11-15T00:00:00Z"));
    expect(s.moon_from_earth.distance_m).toBeGreaterThan(356_000_000);
    expect(s.moon_from_earth.distance_m).toBeLessThan(407_000_000);
    expect(s.sun_from_earth.distance_m / 1000 / AU_KM).toBeGreaterThan(0.98);
    expect(s.moon_from_earth.longitude_deg).toBeGreaterThanOrEqual(0);
    expect(s.moon_from_earth.longitude_deg).toBeLessThan(360);
  });

  it("Sun → Moon + Earth → Sun = Earth → Moon", () => {
    const s = mockCelestialState(new Date("2026-11-15T00:00:00Z"));
    for (let i = 0; i < 3; i++) {
      expect(s.moon_from_sun.position_m[i] + s.sun_from_earth.position_m[i]).toBeCloseTo(
        s.moon_from_earth.position_m[i],
        0,
      );
    }
  });

  it("new Moon at the 2024-04-08 total solar eclipse", () => {
    const s = mockCelestialState(new Date("2024-04-08T18:18:00Z"));
    expect(s.derived.elongation_deg).toBeLessThan(1.0);
    expect(s.derived.illuminated_fraction).toBeLessThan(1e-3);
    expect(s.derived.phase_name).toBe("New Moon");
  });

  it("full Moon at the 2025-03-14 total lunar eclipse", () => {
    const s = mockCelestialState(new Date("2025-03-14T06:59:00Z"));
    expect(s.derived.phase_angle_deg).toBeLessThan(1.5);
    expect(s.derived.illuminated_fraction).toBeGreaterThan(0.999);
    expect(s.derived.phase_name).toBe("Full Moon");
  });

  it("Earth orientation puts the subsolar point near (0°, +1.9°) at 2026-03-20 12:00 UTC", () => {
    // Equinox day: Sun declination ≈ 0; equation of time ≈ −7.5 min ⇒ Sun still ~1.9° east of Greenwich.
    const s = mockCelestialState(new Date("2026-03-20T12:00:00Z"));
    const sunBody = transposeMul(s.earth_orientation as Mat3, s.sun_from_earth.position_m);
    const e = cartesianToEcliptic(sunBody); // same lat/lon maths in any frame
    const lonDeg = e.lon / DEG > 180 ? e.lon / DEG - 360 : e.lon / DEG;
    expect(Math.abs(e.lat / DEG)).toBeLessThan(0.5);
    expect(Math.abs(lonDeg - 1.9)).toBeLessThan(0.5);
  });

  it("warns outside the formulae's stated validity range", () => {
    expect(mockCelestialState(new Date("2070-01-01T00:00:00Z")).warnings).toHaveLength(2);
    expect(mockCelestialState(new Date("2030-01-01T00:00:00Z")).warnings).toHaveLength(1);
  });

  it("rejects an invalid date", () => {
    expect(() => mockCelestialState(new Date("not a date"))).toThrow();
  });

  it("moon track has the expected sample count", () => {
    expect(mockMoonTrack(new Date("2026-11-15T00:00:00Z"), 14, 6)).toHaveLength(113);
  });
});

describe("phaseName", () => {
  it.each([
    [0, "New Moon"],
    [359, "New Moon"],
    [22.4, "New Moon"],
    [22.6, "Waxing crescent"],
    [90, "First quarter"],
    [180, "Full Moon"],
    [270, "Last quarter"],
    [-45, "Waning crescent"],
  ])("%s° → %s", (d, name) => {
    expect(phaseName(d)).toBe(name);
  });
});

describe("moon_orientation", () => {
  it("turns the Moon's near side (body +X) toward Earth, within the ignored ≤5.3° latitude", () => {
    const s = mockCelestialState(new Date("2026-11-15T00:00:00Z"));
    const m = s.moon_orientation;
    const nearSide: Vec3 = [m[0], m[3], m[6]]; // body +X expressed in the ecliptic frame
    const toEarth = s.moon_from_earth.position_m.map((x) => -x) as Vec3;
    expect(angleBetween(nearSide, toEarth) / DEG).toBeLessThan(5.5);
  });
});
