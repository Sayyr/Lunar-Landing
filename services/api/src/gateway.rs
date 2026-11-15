use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};

use crate::celestial::{CelestialStateRequest, CelestialStateResponse};
use crate::envelope::{ApiError, FieldIssue};
use crate::mission::{MissionSimulateRequest, MissionSimulateResponse};
use crate::radio::{RadioLinkRequest, RadioLinkResponse};
use crate::scenario::{ScenarioRequest, ScenarioResponse};
use crate::science::{Provider, ScienceClient};
use crate::terrain::{SlopeCheckRequest, SlopeCheckResponse};

pub const SITES_JSON: &str = include_str!("../../../packages/contracts/fixtures/sites.json");

#[derive(Clone)]
pub struct AppState {
    pub science: ScienceClient,
}

pub async fn health(State(state): State<AppState>) -> Json<Value> {
    let (status, upstream, upstream_error) = match state.science.health().await {
        Ok(v) => ("ok", v, Value::Null),
        Err(e) => ("degraded", Value::Null, Value::String(e)),
    };
    Json(json!({
        "service": "api",
        "status": status,
        "version": env!("CARGO_PKG_VERSION"),
        "upstream": upstream,
        "upstream_error": upstream_error,
    }))
}

pub async fn sites() -> impl IntoResponse {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        SITES_JSON,
    )
}

fn parse_request(body: &Bytes) -> Result<ScenarioRequest, ApiError> {
    let req: ScenarioRequest = serde_json::from_slice(body)
        .map_err(|e| ApiError::validation(vec![FieldIssue::new("body", &e.to_string())]))?;
    req.validate().map_err(ApiError::validation)?;
    Ok(req)
}

pub async fn evaluate_real(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<ScenarioResponse>, ApiError> {
    let req = parse_request(&body)?;
    Ok(Json(state.science.evaluate(&req, Provider::Real).await?))
}

pub async fn evaluate_synthetic(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<ScenarioResponse>, ApiError> {
    let req = parse_request(&body)?;
    Ok(Json(
        state.science.evaluate(&req, Provider::Synthetic).await?,
    ))
}

/// Forwards a validated slope check to the science service (which reads the DEM and decides).
pub async fn slope_check(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<SlopeCheckResponse>, ApiError> {
    const INVALID: &str = "Slope check request is invalid.";
    let req: SlopeCheckRequest = serde_json::from_slice(&body)
        .map_err(|e| ApiError::invalid(INVALID, vec![FieldIssue::new("body", &e.to_string())]))?;
    req.validate().map_err(|d| ApiError::invalid(INVALID, d))?;
    Ok(Json(state.science.slope_check(&req).await?))
}

/// Forwards a validated radio-link request to the science service (geometry and link budget
/// are computed there; the gateway adds no hardware default).
pub async fn radio_link(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<RadioLinkResponse>, ApiError> {
    const INVALID: &str = "Radio link request is invalid.";
    let req: RadioLinkRequest = serde_json::from_slice(&body)
        .map_err(|e| ApiError::invalid(INVALID, vec![FieldIssue::new("body", &e.to_string())]))?;
    req.validate().map_err(|d| ApiError::invalid(INVALID, d))?;
    Ok(Json(state.science.radio_link(&req).await?))
}

fn parse_mission(body: &Bytes) -> Result<MissionSimulateRequest, ApiError> {
    const INVALID: &str = "Mission simulation request is invalid.";
    let req: MissionSimulateRequest = serde_json::from_slice(body)
        .map_err(|e| ApiError::invalid(INVALID, vec![FieldIssue::new("body", &e.to_string())]))?;
    req.validate().map_err(|d| ApiError::invalid(INVALID, d))?;
    Ok(req)
}

/// Forwards a validated mission simulation to the science service (energy balance, visibility,
/// link and slope are computed there; the gateway adds no vehicle figure or default).
pub async fn simulate_real(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<MissionSimulateResponse>, ApiError> {
    let req = parse_mission(&body)?;
    Ok(Json(
        state.science.mission_simulate(&req, Provider::Real).await?,
    ))
}

/// Same, on the science service's SYNTHETIC provider (response labelled `synthetic: true`).
pub async fn simulate_synthetic(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<MissionSimulateResponse>, ApiError> {
    let req = parse_mission(&body)?;
    Ok(Json(
        state
            .science
            .mission_simulate(&req, Provider::Synthetic)
            .await?,
    ))
}

/// Sun/Earth/Moon state for the 3D views, computed by the science service (SPICE). When
/// ephemerides are unavailable the science 503 is forwarded: the gateway invents nothing.
pub async fn celestial_state(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<CelestialStateResponse>, ApiError> {
    const INVALID: &str = "Celestial state request is invalid.";
    let req: CelestialStateRequest = serde_json::from_slice(&body)
        .map_err(|e| ApiError::invalid(INVALID, vec![FieldIssue::new("body", &e.to_string())]))?;
    req.validate().map_err(|d| ApiError::invalid(INVALID, d))?;
    Ok(Json(state.science.celestial_state(&req).await?))
}
