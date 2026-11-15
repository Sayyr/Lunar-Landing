//! Mission-simulation contract types (mirror `packages/contracts/schemas/mission-simulate-*.schema.json`)
//! and gateway-side input validation. No energy balance, geometry or link budget is computed
//! here: the science service owns all of it. Validation mirrors
//! `services/science/src/mission.cpp::parse_mission_request` (same field paths).

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use crate::envelope::FieldIssue;
use crate::radio::{GroundStation, LinkParams, RadioLinkRequest};
use crate::scenario::{ScenarioRequest, ScenarioStatus, Site, TerrainMode, Window};

/// Keep in sync with `services/science/src/mission.cpp::MAX_SEARCH_POINTS`.
pub const MAX_SEARCH_POINTS: f64 = 120.0;
/// Science-side defaults of `search` (mission.hpp); used only for the point-count guard, never
/// written into the forwarded request.
const DEFAULT_SEARCH_MAX_EXTRA_DELAY_HOURS: f64 = 360.0;
const DEFAULT_SEARCH_STEP_HOURS: f64 = 6.0;

/// Required-but-nullable field: the key must be present (serde does not default an `Option`
/// that has a `deserialize_with`), `null` maps to `None`.
fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}

/// Optional-but-not-nullable field: absent = `None` (via `default`), explicit `null` is rejected
/// as the schema requires an object/number.
fn present_not_null<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndPolicy {
    FixedDuration,
    FixedEnd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PanelPointing {
    SunTracking,
    Vertical,
    Horizontal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Delay {
    pub landing_delay_hours: f64,
    pub end_policy: EndPolicy,
    /// Optional and nullable: absent and `null` both mean "not modelled".
    #[serde(default)]
    pub pre_landing_net_load_w: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PowerParams {
    pub panel_area_m2: f64,
    pub panel_efficiency: f64,
    pub panel_pointing: PanelPointing,
    pub load_w: f64,
    pub battery_capacity_wh: f64,
    pub battery_initial_soc: f64,
    pub charge_efficiency: f64,
    pub discharge_efficiency: f64,
}

/// Direct-to-Earth link, as in `RadioLinkRequest` minus the site and time grid (taken from the
/// mission).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MissionRadio {
    pub min_earth_elevation_deg: f64,
    pub link: LinkParams,
    pub stations: Vec<GroundStation>,
}

/// Every key is required; `null` = constraint not applied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MissionConstraints {
    #[serde(deserialize_with = "nullable")]
    pub min_battery_soc: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub max_earth_outage_hours: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub min_contact_hours: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub min_data_volume_mbit: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub max_slope_deg: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub min_slope_ok_fraction: Option<f64>,
}

/// Defaults are applied by the science service and echoed in the response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Search {
    #[serde(
        default,
        deserialize_with = "present_not_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_extra_delay_hours: Option<f64>,
    #[serde(
        default,
        deserialize_with = "present_not_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub step_hours: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MissionSimulateRequest {
    pub site: Site,
    pub landing_utc: String,
    pub surface_hours: f64,
    pub step_minutes: f64,
    pub terrain_mode: TerrainMode,
    #[serde(
        default,
        deserialize_with = "present_not_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub delay: Option<Delay>,
    /// Optional and nullable (energy is the lowest-priority model); serialized as `null` when absent,
    /// as the science echo does.
    #[serde(default)]
    pub power: Option<PowerParams>,
    /// Optional and nullable; serialized as `null` when absent (as the science echo does).
    #[serde(default)]
    pub radio: Option<MissionRadio>,
    pub constraints: MissionConstraints,
    #[serde(
        default,
        deserialize_with = "present_not_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub search: Option<Search>,
}

fn within(value: f64, min: f64, max: f64) -> bool {
    value.is_finite() && (min..=max).contains(&value)
}

fn above_up_to(value: f64, min_exclusive: f64, max: f64) -> bool {
    value.is_finite() && value > min_exclusive && value <= max
}

impl MissionSimulateRequest {
    /// Range checks from the JSON Schema (the science service repeats them).
    pub fn validate(&self) -> Result<(), Vec<FieldIssue>> {
        // Site, landing time, stay and step follow the scenario rules (sample cap included),
        // reported under the mission field names.
        let mut issues: Vec<FieldIssue> = ScenarioRequest {
            site: self.site.clone(),
            start_utc: self.landing_utc.clone(),
            duration_hours: self.surface_hours,
            step_minutes: self.step_minutes,
            terrain_mode: self.terrain_mode,
        }
        .validate()
        .err()
        .unwrap_or_default()
        .into_iter()
        .map(|mut i| {
            i.field = match i.field.as_str() {
                "start_utc" => "landing_utc".into(),
                "duration_hours" => "surface_hours".into(),
                _ => i.field,
            };
            i
        })
        .collect();

        let mut check = |ok: bool, field: &str, issue: &str| {
            if !ok {
                issues.push(FieldIssue::new(field, issue));
            }
        };

        if let Some(d) = &self.delay {
            check(
                within(d.landing_delay_hours, 0.0, 720.0),
                "delay.landing_delay_hours",
                "must be within [0, 720] hours",
            );
            if let Some(w) = d.pre_landing_net_load_w {
                check(
                    within(w, 0.0, 1e5),
                    "delay.pre_landing_net_load_w",
                    "must be within [0, 100000] W",
                );
            }
        }

        if let Some(p) = &self.power {
            check(
                within(p.panel_area_m2, 0.0, 1000.0),
                "power.panel_area_m2",
                "must be within [0, 1000] m2",
            );
            check(
                above_up_to(p.panel_efficiency, 0.0, 1.0),
                "power.panel_efficiency",
                "must be within (0, 1]",
            );
            check(
                within(p.load_w, 0.0, 1e5),
                "power.load_w",
                "must be within [0, 100000] W",
            );
            check(
                above_up_to(p.battery_capacity_wh, 0.0, 1e7),
                "power.battery_capacity_wh",
                "must be within (0, 1e7] Wh",
            );
            check(
                within(p.battery_initial_soc, 0.0, 1.0),
                "power.battery_initial_soc",
                "must be within [0, 1]",
            );
            check(
                above_up_to(p.charge_efficiency, 0.0, 1.0),
                "power.charge_efficiency",
                "must be within (0, 1]",
            );
            check(
                above_up_to(p.discharge_efficiency, 0.0, 1.0),
                "power.discharge_efficiency",
                "must be within (0, 1]",
            );
        }

        // Radio-link rules on the mission grid; site/grid issues are already reported above.
        if let Some(radio) = &self.radio {
            let rl = RadioLinkRequest {
                site: self.site.clone(),
                start_utc: self.landing_utc.clone(),
                duration_hours: self.surface_hours,
                step_minutes: self.step_minutes,
                min_earth_elevation_deg: radio.min_earth_elevation_deg,
                link: radio.link.clone(),
                stations: radio.stations.clone(),
            };
            for i in rl.validate().err().unwrap_or_default() {
                let grid = i.field.starts_with("site")
                    || matches!(
                        i.field.as_str(),
                        "start_utc" | "duration_hours" | "step_minutes"
                    );
                check(grid, &format!("radio.{}", i.field), &i.issue);
            }
        }

        let c = &self.constraints;
        for (value, field, max, issue) in [
            (
                c.min_battery_soc,
                "constraints.min_battery_soc",
                1.0,
                "must be within [0, 1] or null",
            ),
            (
                c.max_earth_outage_hours,
                "constraints.max_earth_outage_hours",
                2160.0,
                "must be within [0, 2160] hours or null",
            ),
            (
                c.min_contact_hours,
                "constraints.min_contact_hours",
                2160.0,
                "must be within [0, 2160] hours or null",
            ),
            (
                c.min_data_volume_mbit,
                "constraints.min_data_volume_mbit",
                f64::MAX,
                "must be a finite number >= 0 or null",
            ),
            (
                c.max_slope_deg,
                "constraints.max_slope_deg",
                90.0,
                "must be within [0, 90] degrees or null",
            ),
            (
                c.min_slope_ok_fraction,
                "constraints.min_slope_ok_fraction",
                1.0,
                "must be within [0, 1] or null",
            ),
        ] {
            if let Some(v) = value {
                check(within(v, 0.0, max), field, issue);
            }
        }

        let (mut max_extra, mut step) = (
            DEFAULT_SEARCH_MAX_EXTRA_DELAY_HOURS,
            DEFAULT_SEARCH_STEP_HOURS,
        );
        let mut search_ok = true;
        if let Some(s) = &self.search {
            if let Some(v) = s.max_extra_delay_hours {
                let ok = within(v, 0.0, 720.0);
                check(
                    ok,
                    "search.max_extra_delay_hours",
                    "must be within [0, 720] hours",
                );
                search_ok &= ok;
                max_extra = v;
            }
            if let Some(v) = s.step_hours {
                let ok = within(v, 0.5, 240.0);
                check(ok, "search.step_hours", "must be within [0.5, 240] hours");
                search_ok &= ok;
                step = v;
            }
        }
        if search_ok && max_extra / step > MAX_SEARCH_POINTS {
            check(
                false,
                "search",
                "at most 120 search points (max_extra_delay_hours / step_hours)",
            );
        }

        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues)
        }
    }
}

// ---------- response ----------

/// `additionalProperties: true` in the schema: extra model fields are passed through.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MissionModel {
    pub ephemeris_provider: String,
    pub horizon_model: String,
    #[serde(deserialize_with = "nullable")]
    pub energy_model: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub radio_model: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreLanding {
    pub planned_landing_utc: String,
    pub landing_utc: String,
    pub landing_delay_hours: f64,
    pub end_policy: EndPolicy,
    #[serde(deserialize_with = "nullable")]
    pub net_load_w: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub energy_wh: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub soc_at_landing: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimelineSample {
    pub utc: String,
    pub sun_visible: bool,
    pub earth_visible: bool,
    /// `None` when no radio is given.
    #[serde(deserialize_with = "nullable")]
    pub link_available: Option<bool>,
    /// The three energy fields are `None` without a power system.
    #[serde(deserialize_with = "nullable")]
    pub solar_w: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub battery_wh: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub soc: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MissionWindows {
    pub sun_visible: Vec<Window>,
    pub earth_visible: Vec<Window>,
    #[serde(deserialize_with = "nullable")]
    pub link_available: Option<Vec<Window>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnergyInventory {
    /// Energy figures are `None` without a power system; Sun hours are always computed.
    #[serde(deserialize_with = "nullable")]
    pub generated_wh: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub load_wh: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub unserved_wh: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub curtailed_wh: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub soc_at_landing: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub final_soc: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub min_soc: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub min_soc_utc: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub hours_below_reserve: Option<f64>,
    pub sun_hours: f64,
    pub longest_sun_outage_hours: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sizing {
    pub reserve_soc: f64,
    #[serde(deserialize_with = "nullable")]
    pub required_battery_wh: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub required_panel_area_m2: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContactBasis {
    RadioLink,
    GeometricEarthVisibility,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Comms {
    pub contact_basis: ContactBasis,
    pub earth_visible_hours: f64,
    pub longest_earth_outage_hours: f64,
    #[serde(deserialize_with = "nullable")]
    pub link_hours: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub longest_link_outage_hours: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub data_volume_mbit: Option<f64>,
}

/// Slope-check summary of the landing disc; `status`/`verdict` are free strings in the schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlopeSummary {
    pub status: String,
    pub verdict: String,
    pub radius_m: f64,
    pub max_slope_deg: f64,
    #[serde(deserialize_with = "nullable")]
    pub fraction_ok: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub slope_max_deg: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub slope_mean_deg: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Inventory {
    pub landing_utc: String,
    pub end_utc: String,
    pub surface_hours: f64,
    pub energy: EnergyInventory,
    /// `None` without a power system.
    #[serde(deserialize_with = "nullable")]
    pub sizing: Option<Sizing>,
    pub comms: Comms,
    #[serde(deserialize_with = "nullable")]
    pub slope: Option<SlopeSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintId {
    BatteryReserve,
    EarthOutage,
    ContactHours,
    DataVolume,
    LandingSlope,
    SurfaceTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintStatus {
    Pass,
    Fail,
    NotEvaluated,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConstraintResult {
    pub id: ConstraintId,
    pub label: String,
    pub status: ConstraintStatus,
    #[serde(deserialize_with = "nullable")]
    pub value: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub limit: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub first_violation_utc: Option<String>,
    pub note: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Go,
    NoGo,
    Incomplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CorrectionKind {
    Abort,
    RetimeLanding,
    /// Plan the mission on the nearest passing date (earlier or later), from `date_scan`.
    ChangeDate,
    /// Nearest site within 10 km whose 4 km disc passes the slope; mission re-simulated there.
    MoveSite,
    /// Smallest slope limit that passes at this site.
    RelaxSlope,
    ShortenStay,
    ResizeBattery,
    ResizePanels,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Correction {
    pub kind: CorrectionKind,
    pub feasible: bool,
    pub summary: String,
    #[serde(deserialize_with = "nullable")]
    pub landing_utc: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub surface_hours: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub battery_capacity_wh: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub panel_area_m2: Option<f64>,
    /// `move_site` only.
    #[serde(deserialize_with = "nullable")]
    pub site: Option<LatLon>,
    /// `relax_slope` only.
    #[serde(deserialize_with = "nullable")]
    pub max_slope_deg: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub verdict: Option<Verdict>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LatLon {
    pub latitude_deg: f64,
    pub longitude_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MissionSimulateResponse {
    pub schema_version: String,
    pub status: ScenarioStatus,
    pub synthetic: bool,
    pub message: String,
    pub request: MissionSimulateRequest,
    pub model: MissionModel,
    /// Free objects in the schema (scenario, radio and DEM provenance shapes differ).
    pub data_provenance: Vec<Map<String, Value>>,
    pub assumptions: Vec<String>,
    pub warnings: Vec<String>,
    pub pre_landing: PreLanding,
    pub timeline: Vec<TimelineSample>,
    pub windows: MissionWindows,
    #[serde(deserialize_with = "nullable")]
    pub inventory: Option<Inventory>,
    pub constraints: Vec<ConstraintResult>,
    pub verdict: Verdict,
    pub corrections: Vec<Correction>,
    /// Only on no_go: the same mission re-simulated at nearby landing dates (no delay).
    #[serde(deserialize_with = "nullable")]
    pub date_scan: Option<DateScan>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DateScan {
    pub step_hours: f64,
    pub range_hours: f64,
    /// Constraints no date can change (the landing slope when it fails at this site).
    pub ignored_constraints: Vec<String>,
    pub points: Vec<DateScanPoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DateScanPoint {
    pub landing_utc: String,
    /// Relative to the planned landing; negative = earlier.
    pub offset_hours: f64,
    pub verdict: Verdict,
    pub failed: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw() -> Value {
        serde_json::from_str(include_str!(
            "../../../packages/contracts/fixtures/mission-simulate-request.valid.json"
        ))
        .unwrap()
    }

    fn req() -> MissionSimulateRequest {
        serde_json::from_value(raw()).unwrap()
    }

    fn fields(r: &MissionSimulateRequest) -> Vec<String> {
        r.validate()
            .err()
            .unwrap_or_default()
            .into_iter()
            .map(|i| i.field)
            .collect()
    }

    #[test]
    fn valid_fixture_passes() {
        assert_eq!(req().validate(), Ok(()));
    }

    #[test]
    fn scenario_rules_use_mission_field_names() {
        let mut r = req();
        r.landing_utc = "2026-11-15T00:00:00+02:00".into();
        r.surface_hours = 0.0;
        r.site.latitude_deg = -91.0;
        assert_eq!(
            fields(&r),
            ["site.latitude_deg", "landing_utc", "surface_hours"]
        );
        let mut r = req();
        r.surface_hours = 2160.0;
        r.step_minutes = 1.0;
        assert_eq!(fields(&r), ["step_minutes"]);
    }

    #[test]
    fn radio_rules_are_prefixed_and_grid_not_duplicated() {
        let mut r = req();
        r.site.latitude_deg = -91.0;
        let radio = r.radio.as_mut().unwrap();
        radio.link.data_rate_bps = 0.0;
        radio.stations[0].longitude_deg = 180.0;
        assert_eq!(
            fields(&r),
            [
                "site.latitude_deg",
                "radio.link.data_rate_bps",
                "radio.stations.0.longitude_deg"
            ]
        );
        let mut r = req();
        r.radio = None;
        assert_eq!(r.validate(), Ok(()));
    }

    #[test]
    fn power_is_optional() {
        let mut r = req();
        r.power = None;
        assert_eq!(r.validate(), Ok(()));
        let mut v = serde_json::to_value(req()).unwrap();
        v.as_object_mut().unwrap().remove("power");
        let parsed: MissionSimulateRequest = serde_json::from_value(v.clone()).unwrap();
        assert!(parsed.power.is_none());
        v["power"] = Value::Null;
        let parsed: MissionSimulateRequest = serde_json::from_value(v).unwrap();
        assert!(parsed.power.is_none());
        // forwarded as an explicit null, which the science service accepts
        assert!(serde_json::to_value(&parsed).unwrap()["power"].is_null());
    }

    #[test]
    fn power_delay_constraints_boundaries() {
        let mut r = req();
        let p = r.power.as_mut().unwrap();
        p.panel_area_m2 = 0.0;
        p.battery_initial_soc = 0.0;
        r.constraints.max_slope_deg = Some(90.0);
        r.delay.as_mut().unwrap().landing_delay_hours = 720.0;
        assert_eq!(r.validate(), Ok(()));
        let p = r.power.as_mut().unwrap();
        p.panel_efficiency = 0.0;
        p.battery_capacity_wh = 0.0;
        r.delay.as_mut().unwrap().pre_landing_net_load_w = Some(-1.0);
        r.constraints.min_battery_soc = Some(1.5);
        r.constraints.min_data_volume_mbit = Some(f64::INFINITY);
        assert_eq!(
            fields(&r),
            [
                "delay.pre_landing_net_load_w",
                "power.panel_efficiency",
                "power.battery_capacity_wh",
                "constraints.min_battery_soc",
                "constraints.min_data_volume_mbit"
            ]
        );
    }

    #[test]
    fn search_point_cap() {
        let mut r = req();
        r.search = Some(Search {
            max_extra_delay_hours: Some(720.0),
            step_hours: Some(5.9),
        });
        assert_eq!(fields(&r), ["search"]);
        // exactly 120 points is allowed
        r.search.as_mut().unwrap().step_hours = Some(6.0);
        assert_eq!(r.validate(), Ok(()));
        // defaults (360 / 6 = 60 points) are fine, and only the given step counts
        r.search = None;
        assert_eq!(r.validate(), Ok(()));
        r.search = Some(Search {
            max_extra_delay_hours: None,
            step_hours: Some(2.0),
        });
        assert_eq!(fields(&r), ["search"]);
    }

    #[test]
    fn required_nullable_and_optional_not_nullable() {
        // constraints: every key required, null allowed
        let mut v = raw();
        v["constraints"]["max_slope_deg"] = Value::Null;
        let r: MissionSimulateRequest = serde_json::from_value(v).unwrap();
        assert_eq!(r.constraints.max_slope_deg, None);
        let mut v = raw();
        v["constraints"]
            .as_object_mut()
            .unwrap()
            .remove("max_slope_deg");
        assert!(serde_json::from_value::<MissionSimulateRequest>(v).is_err());
        // delay / search: optional, but not null
        for key in ["delay", "search"] {
            let mut v = raw();
            v[key] = Value::Null;
            assert!(
                serde_json::from_value::<MissionSimulateRequest>(v).is_err(),
                "{key}"
            );
            let mut v = raw();
            v.as_object_mut().unwrap().remove(key);
            let r: MissionSimulateRequest = serde_json::from_value(v).unwrap();
            assert!(r.validate().is_ok());
            // the gateway does not invent the science defaults
            assert!(serde_json::to_value(&r).unwrap().get(key).is_none());
        }
        // radio: optional and nullable
        let mut v = raw();
        v["radio"] = Value::Null;
        assert!(serde_json::from_value::<MissionSimulateRequest>(v)
            .unwrap()
            .radio
            .is_none());
    }

    #[test]
    fn no_hardware_default_is_invented() {
        let mut v = raw();
        v["power"].as_object_mut().unwrap().remove("load_w");
        assert!(serde_json::from_value::<MissionSimulateRequest>(v).is_err());
        let mut v = raw();
        v["power"]["panel_pointing"] = "tilted".into();
        assert!(serde_json::from_value::<MissionSimulateRequest>(v).is_err());
    }
}
