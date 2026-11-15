//! Earth->Moon transfer + descent contract types (mirror
//! `packages/contracts/schemas/trajectory-simulate-{request,response}.schema.json`) and gateway-side
//! input validation. No trajectory maths here: the science service runs the vecteur-traj tool.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::envelope::FieldIssue;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrajectorySite {
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub altitude_km: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrajectorySimulateRequest {
    pub site: TrajectorySite,
    pub departure_utc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer_days: Option<f64>,
}

impl TrajectorySimulateRequest {
    pub fn validate(&self) -> Result<(), Vec<FieldIssue>> {
        let mut errs = Vec::new();
        let s = &self.site;
        if !(-90.0..=90.0).contains(&s.latitude_deg) {
            errs.push(FieldIssue::new(
                "site.latitude_deg",
                "must be within [-90, 90]",
            ));
        }
        if !(-180.0..180.0).contains(&s.longitude_deg) {
            errs.push(FieldIssue::new(
                "site.longitude_deg",
                "must be within [-180, 180)",
            ));
        }
        if let Some(a) = s.altitude_km {
            if !(0.0..=20.0).contains(&a) {
                errs.push(FieldIssue::new(
                    "site.altitude_km",
                    "must be within [0, 20]",
                ));
            }
        }
        if !crate::scenario::is_utc_z(&self.departure_utc) {
            errs.push(FieldIssue::new(
                "departure_utc",
                "must be an ISO 8601 UTC timestamp ending in 'Z', e.g. 2027-01-01T00:00:00Z",
            ));
        }
        if let Some(d) = self.transfer_days {
            if !(2.0..=10.0).contains(&d) {
                errs.push(FieldIssue::new("transfer_days", "must be within [2, 10]"));
            }
        }
        if errs.is_empty() {
            Ok(())
        } else {
            Err(errs)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrajectoryFrame {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrajectorySegment {
    pub phase: String,
    pub utc: Vec<String>,
    pub positions_m: Vec<[f64; 3]>,
    pub altitude_above_site_km: Vec<f64>,
    pub speed_relative_to_moon_m_s: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrajectorySimulateResponse {
    pub schema_version: String,
    pub status: String,
    pub synthetic: bool,
    pub message: String,
    pub request: TrajectorySimulateRequest,
    pub frame: Option<TrajectoryFrame>,
    pub model: Option<BTreeMap<String, String>>,
    pub segments: Vec<TrajectorySegment>,
    /// The tool's own summary objects, passed through unchanged.
    pub transfer: Option<Value>,
    pub descent: Option<Value>,
    pub assumptions: Vec<String>,
    pub warnings: Vec<String>,
}
