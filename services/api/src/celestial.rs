//! Celestial-state contract types (mirror `packages/contracts/schemas/celestial-state-*.schema.json`)
//! and gateway-side input validation. No astronomy here: the science service computes the state.

use serde::{Deserialize, Serialize};

use crate::envelope::FieldIssue;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CelestialStateRequest {
    pub utc: String,
}

impl CelestialStateRequest {
    pub fn validate(&self) -> Result<(), Vec<FieldIssue>> {
        if crate::scenario::is_utc_z(&self.utc) {
            Ok(())
        } else {
            Err(vec![FieldIssue::new(
                "utc",
                "must be an ISO 8601 UTC timestamp ending in 'Z', e.g. 2026-11-15T00:00:00Z",
            )])
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Relative {
    pub longitude_deg: f64,
    pub latitude_deg: f64,
    pub distance_m: f64,
    pub position_m: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MoonFromEarth {
    pub longitude_deg: f64,
    pub latitude_deg: f64,
    pub distance_m: f64,
    pub position_m: [f64; 3],
    pub right_ascension_deg: f64,
    pub declination_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Derived {
    pub elongation_deg: f64,
    pub phase_angle_deg: f64,
    pub illuminated_fraction: f64,
    pub waxing: bool,
    pub phase_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CelestialModel {
    pub provider: String,
    pub time_scale_note: String,
    pub nominal_accuracy: String,
    pub kernel_set: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CelestialStateResponse {
    pub schema_version: String,
    pub status: String,
    pub synthetic: bool,
    pub utc: String,
    pub frame: Frame,
    pub moon_from_earth: MoonFromEarth,
    pub moon_from_sun: Relative,
    pub sun_from_earth: Relative,
    pub derived: Derived,
    pub earth_orientation: [f64; 9],
    pub moon_orientation: [f64; 9],
    pub model: CelestialModel,
    pub assumptions: Vec<String>,
    pub warnings: Vec<String>,
}
