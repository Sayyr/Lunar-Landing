//! Scenario contract types (mirror `packages/contracts/schemas/scenario-*.schema.json`)
//! and gateway-side input validation. No astronomy is computed here.

use serde::{Deserialize, Serialize};

use crate::error::FieldIssue;

/// Keep in sync with `services/science/src/models.hpp::MAX_SAMPLES`.
pub const MAX_SAMPLES: u64 = 20_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Site {
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    pub observer_height_m: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerrainMode {
    Ideal,
    Dem,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScenarioRequest {
    pub site: Site,
    pub start_utc: String,
    pub duration_hours: f64,
    pub step_minutes: f64,
    pub terrain_mode: TerrainMode,
}

impl ScenarioRequest {
    /// Number of samples including both endpoints (same rule as the science service).
    pub fn sample_count(&self) -> u64 {
        (self.duration_hours * 60.0 / self.step_minutes).floor() as u64 + 1
    }

    /// Range checks from the JSON Schema plus a sample-count guard.
    pub fn validate(&self) -> Result<(), Vec<FieldIssue>> {
        let mut issues = Vec::new();
        let mut check = |ok: bool, field: &str, issue: &str| {
            if !ok {
                issues.push(FieldIssue::new(field, issue));
            }
        };
        let s = &self.site;
        check(
            s.latitude_deg.is_finite() && (-90.0..=90.0).contains(&s.latitude_deg),
            "site.latitude_deg",
            "must be within [-90, 90]",
        );
        check(
            s.longitude_deg.is_finite() && (-180.0..180.0).contains(&s.longitude_deg),
            "site.longitude_deg",
            "must be within [-180, 180) (east-positive)",
        );
        check(
            s.observer_height_m.is_finite() && (0.0..=1000.0).contains(&s.observer_height_m),
            "site.observer_height_m",
            "must be within [0, 1000] meters",
        );
        check(
            is_utc_z(&self.start_utc),
            "start_utc",
            "must be an ISO 8601 UTC timestamp ending in 'Z', e.g. 2026-11-15T00:00:00Z",
        );
        check(
            self.duration_hours.is_finite()
                && self.duration_hours > 0.0
                && self.duration_hours <= 2160.0,
            "duration_hours",
            "must be within (0, 2160]",
        );
        check(
            self.step_minutes.is_finite() && (1.0..=1440.0).contains(&self.step_minutes),
            "step_minutes",
            "must be within [1, 1440]",
        );
        if issues.is_empty() && self.sample_count() > MAX_SAMPLES {
            issues.push(FieldIssue::new(
                "step_minutes",
                &format!(
                    "{} samples exceeds the maximum of {MAX_SAMPLES}",
                    self.sample_count()
                ),
            ));
        }
        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues)
        }
    }
}

fn is_utc_z(s: &str) -> bool {
    // RFC 3339 parse rejects impossible dates; the 'Z' check rejects offsets like +02:00.
    s.ends_with('Z') && s.len() >= 20 && chrono::DateTime::parse_from_rfc3339(s).is_ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScenarioStatus {
    Computed,
    Synthetic,
    NotReady,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelInfo {
    pub ephemeris_provider: String,
    pub horizon_model: String,
    pub body_fixed_frame: Option<String>,
    pub time_scale_note: String,
    pub kernel_set: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provenance {
    pub name: String,
    pub kind: String,
    pub source: String,
    pub version: Option<String>,
    pub license: Option<String>,
    pub notes: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Direction {
    pub azimuth_deg: f64,
    pub elevation_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sample {
    pub utc: String,
    pub sun: Direction,
    pub earth: Direction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Window {
    pub start_utc: String,
    pub end_utc: String,
    pub clipped_start: bool,
    pub clipped_end: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Windows {
    pub sun_visible: Vec<Window>,
    pub earth_visible: Vec<Window>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScenarioResponse {
    pub schema_version: String,
    pub status: ScenarioStatus,
    pub synthetic: bool,
    pub message: String,
    pub request: ScenarioRequest,
    pub model: ModelInfo,
    pub data_provenance: Vec<Provenance>,
    pub assumptions: Vec<String>,
    pub warnings: Vec<String>,
    pub samples: Vec<Sample>,
    pub windows: Windows,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> ScenarioRequest {
        serde_json::from_str(include_str!(
            "../../../packages/contracts/fixtures/scenario-request.valid.json"
        ))
        .unwrap()
    }

    #[test]
    fn valid_fixture_passes() {
        assert_eq!(req().validate(), Ok(()));
        assert_eq!(req().sample_count(), 72 * 6 + 1);
    }

    #[test]
    fn boundaries() {
        let mut r = req();
        r.site.latitude_deg = -90.0;
        r.site.longitude_deg = -180.0;
        assert!(r.validate().is_ok());
        r.site.longitude_deg = 180.0;
        assert_eq!(r.validate().unwrap_err()[0].field, "site.longitude_deg");
        r.site.longitude_deg = f64::NAN;
        assert!(r.validate().is_err());
    }

    #[test]
    fn start_utc_rules() {
        for bad in [
            "2026-11-15T00:00:00+02:00",
            "2026-02-30T00:00:00Z",
            "2026-11-15",
            "",
        ] {
            let mut r = req();
            r.start_utc = bad.into();
            assert!(r.validate().is_err(), "{bad} should be rejected");
        }
        let mut r = req();
        r.start_utc = "2026-11-15T00:00:00.250Z".into();
        assert!(r.validate().is_ok());
    }

    #[test]
    fn sample_cap() {
        let mut r = req();
        r.duration_hours = 2160.0;
        r.step_minutes = 1.0;
        assert_eq!(r.validate().unwrap_err()[0].field, "step_minutes");
    }
}
