//! Slope-check contract types (mirror `packages/contracts/schemas/slope-check-*.schema.json`)
//! and gateway-side input validation. No terrain math here: the science service reads the DEM,
//! computes the slopes and the verdict.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::envelope::FieldIssue;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Zone {
    pub center_latitude_deg: f64,
    pub center_longitude_deg: f64,
    pub radius_m: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlopeCheckRequest {
    pub zone: Zone,
    pub max_slope_deg: f64,
    /// Defaults (1.0 / 0.0) are applied by the science service and echoed in the response.
    /// Absent = `None`; an explicit JSON `null` is rejected (the schema requires a number).
    #[serde(
        default,
        deserialize_with = "number_not_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub required_fraction: Option<f64>,
    #[serde(
        default,
        deserialize_with = "number_not_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_nodata_fraction: Option<f64>,
}

/// Only called when the key is present (absence falls back to `default`), so `null` fails here
/// as "invalid type: null, expected f64" instead of being silently read as "not given".
fn number_not_null<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    f64::deserialize(d).map(Some)
}

impl SlopeCheckRequest {
    /// Range checks from the JSON Schema (the science service repeats them).
    pub fn validate(&self) -> Result<(), Vec<FieldIssue>> {
        let mut issues = Vec::new();
        let mut check = |ok: bool, field: &str, issue: &str| {
            if !ok {
                issues.push(FieldIssue::new(field, issue));
            }
        };
        let z = &self.zone;
        check(
            z.center_latitude_deg.is_finite() && (-90.0..=90.0).contains(&z.center_latitude_deg),
            "zone.center_latitude_deg",
            "must be within [-90, 90]",
        );
        check(
            z.center_longitude_deg.is_finite() && (-180.0..180.0).contains(&z.center_longitude_deg),
            "zone.center_longitude_deg",
            "must be within [-180, 180) (east-positive)",
        );
        check(
            z.radius_m.is_finite() && (20.0..=10_000.0).contains(&z.radius_m),
            "zone.radius_m",
            "must be within [20, 10000] meters",
        );
        check(
            self.max_slope_deg.is_finite()
                && self.max_slope_deg > 0.0
                && self.max_slope_deg <= 90.0,
            "max_slope_deg",
            "must be within (0, 90] degrees",
        );
        for (value, field) in [
            (self.required_fraction, "required_fraction"),
            (self.max_nodata_fraction, "max_nodata_fraction"),
        ] {
            if let Some(v) = value {
                check(
                    v.is_finite() && (0.0..=1.0).contains(&v),
                    field,
                    "must be within [0, 1]",
                );
            }
        }
        if issues.is_empty() {
            Ok(())
        } else {
            Err(issues)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlopeStatus {
    Computed,
    OutOfCoverage,
    DemUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlopeVerdict {
    Pass,
    Fail,
    InsufficientData,
    NotEvaluated,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorstPixel {
    pub latitude_deg: f64,
    pub longitude_deg: f64,
    pub slope_deg: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlopeStats {
    pub pixel_count: u64,
    pub nodata_count: u64,
    pub fraction_ok: f64,
    pub slope_max_deg: Option<f64>,
    pub slope_mean_deg: Option<f64>,
    pub slope_p95_deg: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worst_pixel: Option<WorstPixel>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlopeModel {
    pub method: String,
    pub baseline_m: Option<f64>,
    pub body_fixed_frame: Option<String>,
    pub projection: Option<String>,
}

/// `additionalProperties: true` in the schema: extra provenance fields are passed through.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DemProvenance {
    pub dem_product: String,
    #[serde(default)]
    pub dem_sha256: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlopeCheckResponse {
    pub status: SlopeStatus,
    pub verdict: SlopeVerdict,
    pub request: SlopeCheckRequest,
    pub stats: Option<SlopeStats>,
    pub model: SlopeModel,
    pub data_provenance: DemProvenance,
    pub assumptions: Vec<String>,
    pub warnings: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> SlopeCheckRequest {
        serde_json::from_str(include_str!(
            "../../../packages/contracts/fixtures/slope-check-request.valid.json"
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
        r.zone.radius_m = 20.0;
        r.max_slope_deg = 90.0;
        r.required_fraction = None;
        assert!(r.validate().is_ok());
        r.zone.radius_m = 19.9;
        assert_eq!(r.validate().unwrap_err()[0].field, "zone.radius_m");
        let mut r = req();
        r.max_slope_deg = 0.0;
        assert_eq!(r.validate().unwrap_err()[0].field, "max_slope_deg");
        let mut r = req();
        r.max_nodata_fraction = Some(f64::NAN);
        assert_eq!(r.validate().unwrap_err()[0].field, "max_nodata_fraction");
    }

    #[test]
    fn defaults_are_not_invented_by_the_gateway() {
        let r: SlopeCheckRequest = serde_json::from_str(
            r#"{"zone":{"center_latitude_deg":-89.5,"center_longitude_deg":0,"radius_m":500},"max_slope_deg":10}"#,
        )
        .unwrap();
        let v = serde_json::to_value(&r).unwrap();
        assert!(v.get("required_fraction").is_none());
        assert!(v.get("max_nodata_fraction").is_none());
    }

    #[test]
    fn explicit_null_is_rejected() {
        for field in ["required_fraction", "max_nodata_fraction"] {
            let raw = format!(
                r#"{{"zone":{{"center_latitude_deg":-89.5,"center_longitude_deg":0,"radius_m":500}},"max_slope_deg":10,"{field}":null}}"#
            );
            assert!(
                serde_json::from_str::<SlopeCheckRequest>(&raw).is_err(),
                "{field}"
            );
        }
    }
}
