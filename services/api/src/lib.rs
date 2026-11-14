//! SELENE API gateway. Validates inputs, forwards to the science service and
//! exposes stable REST contracts. All astronomy lives in `services/science`.

pub mod error;
pub mod scenario;
pub mod science;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::error::{ApiError, FieldIssue};
use crate::scenario::{ScenarioRequest, ScenarioResponse};
use crate::science::{Provider, ScienceClient};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Preset sites, served verbatim from the shared contracts package.
pub const SITES_JSON: &str = include_str!("../../../packages/contracts/fixtures/sites.json");

#[derive(Clone)]
pub struct AppState {
    pub science: ScienceClient,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/sites", get(sites))
        .route("/scenarios/evaluate", post(evaluate_real))
        .route("/demo/synthetic/evaluate", post(evaluate_synthetic))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    let (status, upstream, upstream_error) = match state.science.health().await {
        Ok(v) => ("ok", v, Value::Null),
        Err(e) => ("degraded", Value::Null, Value::String(e)),
    };
    Json(json!({
        "service": "api",
        "status": status,
        "version": VERSION,
        "upstream": upstream,
        "upstream_error": upstream_error,
    }))
}

async fn sites() -> impl IntoResponse {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        SITES_JSON,
    )
}

/// Parse and validate the body ourselves so every failure uses the error envelope.
fn parse_request(body: &Bytes) -> Result<ScenarioRequest, ApiError> {
    let req: ScenarioRequest = serde_json::from_slice(body)
        .map_err(|e| ApiError::validation(vec![FieldIssue::new("body", &e.to_string())]))?;
    req.validate().map_err(ApiError::validation)?;
    Ok(req)
}

async fn evaluate_real(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<ScenarioResponse>, ApiError> {
    let req = parse_request(&body)?;
    Ok(Json(state.science.evaluate(&req, Provider::Real).await?))
}

/// SYNTHETIC demo data for UI development; never for analysis.
async fn evaluate_synthetic(
    State(state): State<AppState>,
    body: Bytes,
) -> Result<Json<ScenarioResponse>, ApiError> {
    let req = parse_request(&body)?;
    Ok(Json(
        state.science.evaluate(&req, Provider::Synthetic).await?,
    ))
}
