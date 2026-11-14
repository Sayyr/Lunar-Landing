// Radio-link form state → RadioLinkRequest. No link budget or geometry is computed in the
// browser: the science service owns both. This file only holds editable starting values.
import type { GroundStation, LinkParams, RadioLinkRequest, ScenarioRequest } from "../api/types";

/**
 * ILLUSTRATIVE starting values so the form is not empty. They describe no real spacecraft or
 * mission: replace them with the figures of the system under study.
 */
export const EXAMPLE_LINK: LinkParams = {
  frequency_hz: 2.25e9,
  eirp_dbw: 13,
  rx_g_over_t_db_k: 30,
  other_losses_db: 3,
  data_rate_bps: 100_000,
  required_ebn0_db: 4,
};

/**
 * Approximate locations of the three NASA Deep Space Network complexes (complex centre, not a
 * specific antenna; rounded to ~0.01°). Public knowledge, e.g. https://www.nasa.gov/directorates/somd/space-communications-navigation-program/deep-space-network/
 * Using these stations does not imply DSN availability, scheduling or support.
 */
export const STATION_PRESETS: Omit<GroundStation, "min_elevation_deg">[] = [
  { name: "Goldstone, USA (DSN complex, approx.)", latitude_deg: 35.43, longitude_deg: -116.89, altitude_m: 1000 },
  { name: "Madrid, Spain (DSN complex, approx.)", latitude_deg: 40.43, longitude_deg: -4.25, altitude_m: 800 },
  { name: "Canberra, Australia (DSN complex, approx.)", latitude_deg: -35.4, longitude_deg: 148.98, altitude_m: 700 },
];

export interface RadioSettings {
  link: LinkParams;
  /** lunar-side antenna mask on the Earth's centre, degrees */
  minEarthElevationDeg: number;
  /** elevation mask applied to every selected station, degrees */
  stationMaskDeg: number;
  /** indices into STATION_PRESETS */
  stations: number[];
}

export const DEFAULT_RADIO_SETTINGS: RadioSettings = {
  link: EXAMPLE_LINK,
  minEarthElevationDeg: 0,
  stationMaskDeg: 10,
  stations: [0, 1, 2],
};

/** Same site and time grid as the scenario; terrain_mode is not part of a radio-link request. */
export function buildRadioRequest(scenario: ScenarioRequest, s: RadioSettings): RadioLinkRequest {
  return {
    site: scenario.site,
    start_utc: scenario.start_utc,
    duration_hours: scenario.duration_hours,
    step_minutes: scenario.step_minutes,
    min_earth_elevation_deg: s.minEarthElevationDeg,
    link: s.link,
    stations: s.stations
      .filter((i, k, all) => i >= 0 && i < STATION_PRESETS.length && all.indexOf(i) === k)
      .map((i) => ({ ...STATION_PRESETS[i], min_elevation_deg: s.stationMaskDeg })),
  };
}

/** "3 d 4.5 h", "12.0 h", "45 min". */
export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours)) return "—";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  const d = Math.floor(hours / 24);
  return `${d} d ${(hours - d * 24).toFixed(1)} h`;
}

export const formatPercent = (fraction: number | null): string =>
  fraction === null ? "—" : `${(fraction * 100).toFixed(1)} %`;
