// Mission presets built from REAL, published missions. Every value is either a cited public fact or
// an explicitly labelled assumption (vehicle figures that were never published). Nothing here is a
// result: the simulation is run by the science service when the preset is played.
import type { ScenarioRequest } from "../api/types";
import { LANDING_SITES } from "../lunar/landingSites";
import type { MissionSettings } from "./mission";

export interface PresetFact {
  label: string;
  value: string;
  source: string;
  url: string;
}

export interface MissionPreset {
  id: string;
  name: string;
  summary: string;
  scenario: ScenarioRequest;
  settings: MissionSettings;
  /** vehicle power figures offered when the user turns energy on (null in settings = off by default) */
  powerValues?: MissionSettings["power"];
  /** published facts the preset uses, with sources */
  facts: PresetFact[];
  /** values that are NOT published and were assumed to run the model */
  assumed: string[];
  /** what to compare the simulated result with */
  check: string;
}

const vikram = LANDING_SITES.find((s) => s.id === "Vikram2")!;
const ISRO_BROCHURE = "https://www.isro.gov.in/NSPD2024/assets/pdf/CH3%20Landing%20Brochure-Pagewise.pdf";
const ISRO_SLEEP = "https://www.newsonair.gov.in/tag/vikram-lander-of-chandrayan-3-put-into-sleep-mode/";
const LANDING_UTC = "2023-08-23T12:33:00Z"; // 18:03 IST
const SLEEP_UTC = "2023-09-04T02:30:00Z"; // ≈ 08:00 IST
const PUBLISHED_ARRAY_W = 738;

export const MISSION_PRESETS: MissionPreset[] = [
  {
    id: "chandrayaan3-vikram",
    name: "Chandrayaan-3 · Vikram lander (2023)",
    summary:
      "ISRO's Vikram landed at 69.37°S on 23 Aug 2023, operated on solar power through one lunar day and was put to sleep on 4 Sep 2023, before local sunset.",
    scenario: {
      site: { latitude_deg: vikram.lat, longitude_deg: vikram.lon, observer_height_m: 2 },
      start_utc: LANDING_UTC,
      duration_hours: (Date.parse(SLEEP_UTC) - Date.parse(LANDING_UTC)) / 3_600_000,
      step_minutes: 10,
      // 69.4°S is outside the LOLA 85°S–90°S terrain DEM: only the ideal horizon is available there.
      terrain_mode: "ideal",
    },
    settings: {
      power: null, // energy is optional: off by default (its load and battery are not published)
      constraints: {
        min_battery_soc: null,
        max_earth_outage_hours: 48,
        min_contact_hours: null,
        min_data_volume_mbit: null,
        max_slope_deg: null, // outside the 20 m slope DEM (85°S–90°S)
        min_slope_ok_fraction: null,
      },
      radio: null,
      preLandingLoadW: null,
      endPolicy: "fixed_duration",
    },
    powerValues: {
        // One "equivalent" square metre whose efficiency makes the peak output equal the published
        // 738 W (S0 = 1361 W/m²). The real array geometry is not modelled; the split is arbitrary.
        panel_area_m2: 1,
        panel_efficiency: PUBLISHED_ARRAY_W / 1361,
        panel_pointing: "vertical",
        load_w: 300,
        battery_capacity_wh: 2000,
        battery_initial_soc: 0.9,
        charge_efficiency: 0.95,
        discharge_efficiency: 0.95,
    },
    facts: [
      { label: "Landing site", value: `${Math.abs(vikram.lat)}°S, ${vikram.lon}°E (±${vikram.uncertainty_m} m)`, source: "LROC NAC, Wagner et al. (2017) table", url: "https://doi.org/10.1016/j.icarus.2016.05.011" },
      { label: "Landing", value: "23 Aug 2023, 12:33 UTC (18:03 IST)", source: "collectSPACE (ISRO landing coverage)", url: "https://www.collectspace.com/news/news-082323a-india-chandrayaan-3-moon-landing.html" },
      { label: "End of operations", value: "Vikram set into sleep mode ≈ 08:00 IST on 4 Sep 2023 (02:30 UTC)", source: "ISRO via All India Radio", url: ISRO_SLEEP },
      { label: "Design life", value: "1 lunar day (≈ 14 Earth days), solar powered", source: "ISRO landing brochure", url: ISRO_BROCHURE },
      { label: "Lander power generation", value: `${PUBLISHED_ARRAY_W} W (design figure; the brochure's solstice wording varies)`, source: "ISRO landing brochure", url: ISRO_BROCHURE },
    ],
    assumed: [
      "Energy is OFF by default (optional). If you turn it on: load 300 W, battery 2000 Wh at 90 % charge, 95 % charge/discharge efficiency — NOT published by ISRO; replace them if you have better figures.",
      "Array modelled as a vertical panel turned to the Sun with a 738 W peak; the real panel layout and its Sun-angle losses are not modelled.",
      "Ideal geometric horizon (the site is outside the LOLA polar DEM); landing slope not checked for the same reason.",
      "Contact = geometric Earth visibility only (Vikram used ISRO's ground network and the orbiter relay; no link budget here).",
    ],
    check:
      "Compare with the real mission: our ephemerides put local sunrise at 21 Aug 2023 10:29 UTC and sunset at 4 Sep 2023 16:07 UTC (ideal horizon), so the whole 23 Aug → 4 Sep operating period should be in sunlight — Vikram was put to sleep ≈ 14 h before computed sunset. With energy off, GO rests on Earth contact only; with energy on, it also depends on the assumed load and battery.",
  },
];
