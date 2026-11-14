// DRAFT contract for a future `GET /celestial/state?utc=...` endpoint (not yet in
// packages/contracts — add a JSON Schema there when the backend is implemented).
// Public units follow CLAUDE.md: degrees, metres, UTC ISO 8601.

export interface EclipticCoords {
  /** ecliptic longitude, degrees in [0, 360) */
  longitude_deg: number;
  /** ecliptic latitude, degrees in [-90, 90] */
  latitude_deg: number;
  distance_m: number;
  /** Cartesian position in the response frame, metres */
  position_m: [number, number, number];
}

/** Vector from the observer to the target, both named by the response key (`moon_from_earth`…). */
export type RelativePosition = EclipticCoords;

export interface CelestialStateResponse {
  schema_version: "0.0.1-draft";
  status: "synthetic" | "computed";
  synthetic: boolean;
  utc: string;
  frame: {
    name: string;
    description: string;
  };
  moon_from_earth: RelativePosition & { right_ascension_deg: number; declination_deg: number };
  moon_from_sun: RelativePosition;
  sun_from_earth: RelativePosition;
  derived: {
    /** angle Sun–Earth–Moon (as seen from Earth), degrees */
    elongation_deg: number;
    /** angle Sun–Moon–Earth (as seen from the Moon), degrees */
    phase_angle_deg: number;
    /** fraction of the Moon's disc illuminated as seen from Earth, 0..1 */
    illuminated_fraction: number;
    waxing: boolean;
    phase_name: string;
  };
  /** visualization only: 3×3 row-major rotation Earth body-fixed → response frame */
  earth_orientation: number[];
  /** visualization only: 3×3 row-major rotation Moon body-fixed (lon 0 = mean sub-Earth point) → response frame */
  moon_orientation: number[];
  model: {
    provider: "mock_low_precision" | "spice";
    time_scale_note: string;
    nominal_accuracy: string;
  };
  assumptions: string[];
  warnings: string[];
}
