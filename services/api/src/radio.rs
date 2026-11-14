//! Radio-link contract types (mirror `packages/contracts/schemas/radio-link-*.schema.json`)
//! and gateway-side input validation. No link budget or geometry is computed here: the science
//! service owns both.

use serde::{Deserialize, Serialize};

use crate::envelope::FieldIssue;
use crate::scenario::{Provenance, ScenarioRequest, Site, TerrainMode, Window};

pub const MAX_STATIONS: usize = 8;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinkParams {
    pub frequency_hz: f64,
    pub eirp_dbw: f64,
    pub rx_g_over_t_db_k: f64,
    pub other_losses_db: f64,
    pub data_rate_bps: f64,
    pub required_ebn0_db: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroundStation {
    pub name: String,
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    pub altitude_m: f64,
    pub min_elevation_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RadioLinkRequest {
    pub site: Site,
    pub start_utc: String,
    pub duration_hours: f64,
    pub step_minutes: f64,
    pub min_earth_elevation_deg: f64,
    pub link: LinkParams,
    pub stations: Vec<GroundStation>,
}

fn within(value: f64, min: f64, max: f64) -> bool {
    value.is_finite() && (min..=max).contains(&value)
}

impl RadioLinkRequest {
    /// Range checks from the JSON Schema (the science service repeats them).
    pub fn validate(&self) -> Result<(), Vec<FieldIssue>> {
        // Site and time grid follow the scenario rules, sample cap included.
        let mut issues = ScenarioRequest {
            site: self.site.clone(),
            start_utc: self.start_utc.clone(),
            duration_hours: self.duration_hours,
            step_minutes: self.step_minutes,
            terrain_mode: TerrainMode::Ideal,
        }
        .validate()
        .err()
        .unwrap_or_default();
        let mut check = |ok: bool, field: &str, issue: &str| {
            if !ok {
                issues.push(FieldIssue::new(field, issue));
            }
        };
        check(
            within(self.min_earth_elevation_deg, 0.0, 90.0),
            "min_earth_elevation_deg",
            "must be within [0, 90] degrees",
        );
        let l = &self.link;
        check(
            within(l.frequency_hz, 1e6, 1e12),
            "link.frequency_hz",
            "must be within [1e6, 1e12] Hz",
        );
        check(
            within(l.eirp_dbw, -100.0, 200.0),
            "link.eirp_dbw",
            "must be within [-100, 200] dBW",
        );
        check(
            within(l.rx_g_over_t_db_k, -100.0, 100.0),
            "link.rx_g_over_t_db_k",
            "must be within [-100, 100] dB/K",
        );
        check(
            within(l.other_losses_db, 0.0, 100.0),
            "link.other_losses_db",
            "must be within [0, 100] dB",
        );
        check(
            within(l.data_rate_bps, 1.0, 1e12),
            "link.data_rate_bps",
            "must be within [1, 1e12] bit/s",
        );
        check(
            within(l.required_ebn0_db, -20.0, 60.0),
            "link.required_ebn0_db",
            "must be within [-20, 60] dB",
        );
        check(
            (1..=MAX_STATIONS).contains(&self.stations.len()),
            "stations",
            "must list between 1 and 8 ground stations",
        );
        for (i, s) in self.stations.iter().enumerate() {
            let field = |name: &str| format!("stations.{i}.{name}");
            check(
                (1..=64).contains(&s.name.len()),
                &field("name"),
                "must have between 1 and 64 characters",
            );
            check(
                !self.stations[..i].iter().any(|o| o.name == s.name),
                &field("name"),
                "station names must be unique",
            );
            check(
                within(s.latitude_deg, -90.0, 90.0),
                &field("latitude_deg"),
                "must be within [-90, 90]",
            );
            check(
                s.longitude_deg.is_finite() && (-180.0..180.0).contains(&s.longitude_deg),
                &field("longitude_deg"),
                "must be within [-180, 180) (east-positive)",
            );
            check(
                within(s.altitude_m, -500.0, 9000.0),
                &field("altitude_m"),
                "must be within [-500, 9000] meters",
            );
            check(
                within(s.min_elevation_deg, 0.0, 90.0),
                &field("min_elevation_deg"),
                "must be within [0, 90] degrees",
            );
        }
        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RadioModel {
    pub tier: String,
    pub ephemeris_provider: String,
    pub horizon_model: String,
    pub body_fixed_frame: String,
    pub time_scale_note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RadioSummary {
    pub span_hours: f64,
    pub earth_visible_fraction: Option<f64>,
    pub ground_station_visible_fraction: Option<f64>,
    pub link_available_fraction: Option<f64>,
    pub longest_link_outage_hours: f64,
    pub link_margin_db_min: f64,
    pub link_margin_db_max: f64,
    pub max_abs_doppler_hz: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EarthDirection {
    pub azimuth_deg: f64,
    pub elevation_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RadioSample {
    pub utc: String,
    pub earth: EarthDirection,
    pub earth_visible: bool,
    pub station: String,
    pub station_elevation_deg: f64,
    pub station_visible: bool,
    pub range_m: f64,
    pub range_rate_m_s: f64,
    pub doppler_hz: f64,
    pub fspl_db: f64,
    pub cn0_dbhz: f64,
    pub ebn0_db: f64,
    pub margin_db: f64,
    pub link_available: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StationWindows {
    pub name: String,
    pub windows: Vec<Window>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RadioWindows {
    pub earth_visible: Vec<Window>,
    pub ground_station_visible: Vec<Window>,
    pub link_available: Vec<Window>,
    pub stations: Vec<StationWindows>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RadioLinkResponse {
    pub schema_version: String,
    pub status: String,
    pub message: String,
    pub request: RadioLinkRequest,
    pub model: RadioModel,
    pub data_provenance: Vec<Provenance>,
    pub assumptions: Vec<String>,
    pub warnings: Vec<String>,
    pub summary: RadioSummary,
    pub samples: Vec<RadioSample>,
    pub windows: RadioWindows,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> RadioLinkRequest {
        serde_json::from_str(include_str!(
            "../../../packages/contracts/fixtures/radio-link-request.valid.json"
        ))
        .unwrap()
    }

    #[test]
    fn valid_fixture_passes() {
        assert_eq!(req().validate(), Ok(()));
    }

    #[test]
    fn boundaries() {
        let mut r = req();
        r.link.other_losses_db = 0.0;
        r.min_earth_elevation_deg = 90.0;
        r.stations[0].longitude_deg = -180.0;
        assert!(r.validate().is_ok());
        r.stations[0].longitude_deg = 180.0;
        assert_eq!(
            r.validate().unwrap_err()[0].field,
            "stations.0.longitude_deg"
        );
        let mut r = req();
        r.link.frequency_hz = f64::NAN;
        assert_eq!(r.validate().unwrap_err()[0].field, "link.frequency_hz");
        let mut r = req();
        r.stations.clear();
        assert_eq!(r.validate().unwrap_err()[0].field, "stations");
        let mut r = req();
        r.stations[1].name = r.stations[0].name.clone();
        assert_eq!(r.validate().unwrap_err()[0].field, "stations.1.name");
    }

    #[test]
    fn scenario_rules_apply_to_site_and_grid() {
        let mut r = req();
        r.site.latitude_deg = -91.0;
        r.duration_hours = 2160.0;
        r.step_minutes = 0.5;
        let fields: Vec<String> = r
            .validate()
            .unwrap_err()
            .into_iter()
            .map(|i| i.field)
            .collect();
        assert_eq!(fields, ["site.latitude_deg", "step_minutes"]);
        let mut r = req();
        r.duration_hours = 2160.0;
        r.step_minutes = 1.0;
        assert_eq!(r.validate().unwrap_err()[0].field, "step_minutes");
    }

    #[test]
    fn no_hardware_default_is_invented() {
        let mut raw: serde_json::Value = serde_json::to_value(req()).unwrap();
        raw["link"].as_object_mut().unwrap().remove("eirp_dbw");
        assert!(serde_json::from_value::<RadioLinkRequest>(raw).is_err());
    }
}
