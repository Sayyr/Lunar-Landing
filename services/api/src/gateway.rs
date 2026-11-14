use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;

use crate::envelope::{ApiError, FieldIssue};
use crate::scenario::{ScenarioRequest, ScenarioResponse};
use crate::science::{Provider, ScienceClient};

pub const SITES_JSON: &str = include_str!("../../../packages/contracts/fixtures/sites.json");

#[derive(Clone)]
pub struct AppState {
    pub science: ScienceClient,
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
