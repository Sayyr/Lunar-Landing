// Mirror of packages/contracts/schemas/celestial-{state,tracks}-response.schema.json (`POST /celestial/state`
// and `/celestial/tracks`, provider "spice"). Unavailable ephemerides are a 503, never a response.
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
  schema_version: "0.1.0";
  status: "computed";
  synthetic: false;
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
  model: CelestialModel;
  assumptions: string[];
  warnings: string[];
}

export interface CelestialModel {
  provider: "spice";
  time_scale_note: string;
  nominal_accuracy: string;
  kernel_set: string[];
}

/** One orbit trace: geometric Earth→body positions (metres, response frame) at a fixed step. */
export interface Track {
  start_utc: string;
  step_hours: number;
  positions_m: [number, number, number][];
}

export interface CelestialTracksResponse {
  schema_version: "0.1.0";
  status: "computed";
  synthetic: false;
  utc: string;
  frame: { name: string; description: string };
  /** one mean sidereal month centred on utc */
  moon_from_earth: Track;
  /** Earth→Sun over one Julian year centred on utc (Earth's orbit is its opposite) */
  sun_from_earth: Track;
  model: CelestialModel;
  assumptions: string[];
  warnings: string[];
}
