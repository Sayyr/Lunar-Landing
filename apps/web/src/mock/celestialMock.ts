// Mock provider shaped like the future backend response. Everything is flagged `synthetic`.
// Swap point for backend integration: src/api/celestial.ts.

import type { CelestialStateResponse, RelativePosition } from "../api/celestialTypes";
import {
  angleBetween,
  cartesianToEcliptic,
  DEG,
  earthFixedToEcliptic,
  eclipticToCartesian,
  eclipticToEquatorial,
  julianDateTt,
  julianDateUtc,
  type Mat3,
  meanObliquity,
  moonGeocentric,
  normDeg,
  sub,
  sunGeocentric,
  type Vec3,
} from "./lowPrecisionEphemeris";

const KM_TO_M = 1000; // internal km → public metres

/** Years where every formula is inside the range its source states. */
export const MOCK_VALID_FROM_YEAR = 1950;
export const MOCK_VALID_TO_YEAR = 2050;

const kmToM = (v: Vec3): Vec3 => [v[0] * KM_TO_M, v[1] * KM_TO_M, v[2] * KM_TO_M];

function relative(vKm: Vec3): RelativePosition {
  const e = cartesianToEcliptic(vKm);
  return {
    longitude_deg: e.lon / DEG,
    latitude_deg: e.lat / DEG,
    distance_m: e.distKm * KM_TO_M,
    position_m: kmToM(vKm),
  };
}

/** Tidally locked Moon: body +X (lon 0) toward Earth, pole along the ecliptic pole. */
function moonFixedToEcliptic(moonLon: number): Mat3 {
  const a = moonLon + Math.PI;
  const c = Math.cos(a), s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function phaseName(elongationLonDeg: number): string {
  // Eight named phases by Moon−Sun ecliptic longitude difference (0 = new, 180 = full).
  const names = [
    "New Moon",
    "Waxing crescent",
    "First quarter",
    "Waxing gibbous",
    "Full Moon",
    "Waning gibbous",
    "Last quarter",
    "Waning crescent",
  ];
  const d = normDeg(elongationLonDeg);
  return names[Math.floor(((d + 22.5) % 360) / 45)];
}

export function mockCelestialState(date: Date): CelestialStateResponse {
  if (Number.isNaN(date.getTime())) throw new Error("invalid date");
  const jdUt = julianDateUtc(date);
  const jdTt = julianDateTt(date);

  const moon = moonGeocentric(jdTt);
  const sun = sunGeocentric(jdTt);
  const moonGeo = eclipticToCartesian(moon); // Earth → Moon, km
  const sunGeo = eclipticToCartesian(sun); // Earth → Sun, km
  const moonHelio = sub(moonGeo, sunGeo); // Sun → Moon, km

  const elongation = angleBetween(sunGeo, moonGeo);
  const phaseAngle = angleBetween(sub(sunGeo, moonGeo), sub([0, 0, 0], moonGeo));
  const dLonDeg = normDeg((moon.lon - sun.lon) / DEG);
  const eq = eclipticToEquatorial(moon, meanObliquity(jdTt));

  const year = date.getUTCFullYear();
  const warnings = [
    "SYNTHETIC MOCK DATA — computed in the browser from low-precision published formulae, not from SPICE. Do not use for analysis.",
  ];
  if (year < MOCK_VALID_FROM_YEAR || year > MOCK_VALID_TO_YEAR) {
    warnings.push(
      `Date outside ${MOCK_VALID_FROM_YEAR}–${MOCK_VALID_TO_YEAR}: the low-precision Sun formula is outside its stated range; errors grow.`,
    );
  }

  return {
    schema_version: "0.0.1-draft",
    status: "synthetic",
    synthetic: true,
    utc: date.toISOString(),
    frame: {
      name: "ECLIPTIC_OF_DATE (geocentric origin)",
      description:
        "Ecliptic and mean equinox of date. +X toward the mean equinox, +Z toward the north ecliptic pole. Not J2000 / ECLIPJ2000.",
    },
    moon_from_earth: {
      ...relative(moonGeo),
      right_ascension_deg: eq.ra / DEG,
      declination_deg: eq.dec / DEG,
    },
    moon_from_sun: relative(moonHelio),
    sun_from_earth: relative(sunGeo),
    derived: {
      elongation_deg: elongation / DEG,
      phase_angle_deg: phaseAngle / DEG,
      illuminated_fraction: (1 + Math.cos(phaseAngle)) / 2,
      waxing: dLonDeg < 180,
      phase_name: phaseName(dLonDeg),
    },
    earth_orientation: earthFixedToEcliptic(jdUt, jdTt),
    moon_orientation: moonFixedToEcliptic(moon.lon),
    model: {
      provider: "mock_low_precision",
      time_scale_note: "UTC input; TT = UTC + 69.184 s (TAI−UTC = 37 s, no leap second after 2017 assumed); UT1 ≈ UTC.",
      nominal_accuracy:
        "Source-stated (not validated here): Moon λ 0.3°, β 0.2°, distance ~0.3 %; Sun λ 0.01° (1950–2050).",
    },
    assumptions: [
      "Moon: Astronomical Almanac low-precision series (6 longitude, 4 latitude, 5 parallax terms).",
      "Sun: Astronomical Almanac low-precision formula; ecliptic latitude of the Sun taken as 0.",
      "Moon seen from the Sun = (Earth→Moon) − (Earth→Sun); light-time and aberration not modelled consistently.",
      "Illuminated fraction k = (1 + cos i)/2 with i the Sun–Moon–Earth phase angle (spherical Moon, no terrain).",
      "Earth orientation (texture only): GMST rotation + mean obliquity; no nutation, polar motion or UT1−UTC.",
      "Moon orientation (texture only): mean near side toward Earth, pole normal to the ecliptic; libration and the 1.54° tilt ignored.",
    ],
    warnings,
  };
}

/** Earth→Moon positions (metres, frame of each epoch) over a window, for drawing an orbit trace. */
export function mockMoonTrack(center: Date, halfSpanDays: number, stepHours: number): [number, number, number][] {
  const pts: [number, number, number][] = [];
  const n = Math.round((2 * halfSpanDays * 24) / stepHours); // round: span/step is often meant to be exact
  const t0 = center.getTime() - halfSpanDays * 86_400_000;
  for (let i = 0; i <= n; i++) {
    const v = eclipticToCartesian(moonGeocentric(julianDateTt(new Date(t0 + i * stepHours * 3_600_000))));
    pts.push(kmToM(v));
  }
  return pts;
}

/** Earth→Sun positions (metres) over one year starting half a year before `center`. */
export function mockSunTrack(center: Date, samples = 180): [number, number, number][] {
  const pts: [number, number, number][] = [];
  const span = 365.25 * 86_400_000;
  const t0 = center.getTime() - span / 2;
  for (let i = 0; i <= samples; i++) {
    const v = eclipticToCartesian(sunGeocentric(julianDateTt(new Date(t0 + (i * span) / samples))));
    pts.push(kmToM(v));
  }
  return pts;
}
