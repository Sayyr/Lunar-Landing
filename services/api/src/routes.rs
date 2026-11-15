use axum::{
    http::StatusCode,
    routing::{get, post},
    Router,
};

use crate::{
    envelope::{ApiError, ErrorCode},
    gateway::{self, AppState},
    handler,
    service::SiteService,
};

pub fn site_router(service: SiteService) -> Router {
    Router::new()
        .route("/calcule", post(handler::site))
        .with_state(service)
}

pub fn gateway_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(gateway::health))
        .route("/sites", get(gateway::sites))
        .route("/scenarios/evaluate", post(gateway::evaluate_real))
        .route(
            "/demo/synthetic/evaluate",
            post(gateway::evaluate_synthetic),
        )
        .route("/scenarios/simulate", post(gateway::simulate_real))
        .route(
            "/demo/synthetic/simulate",
            post(gateway::simulate_synthetic),
        )
        .route("/terrain/slope/check", post(gateway::slope_check))
        .route("/scenarios/radio-link", post(gateway::radio_link))
        .route("/celestial/state", post(gateway::celestial_state))
        .route("/celestial/tracks", post(gateway::celestial_tracks))
        .route("/trajectory/simulate", post(gateway::trajectory_simulate))
        .with_state(state)
}

pub fn router(service: SiteService, state: AppState) -> Router {
    // error.schema.json: every non-2xx response carries the error envelope, unknown routes and
    // wrong methods included.
    Router::new()
        .nest("/api/v1", site_router(service).merge(gateway_router(state)))
        .fallback(|| async {
            ApiError::new(StatusCode::NOT_FOUND, ErrorCode::NotFound, "Not Found")
        })
        .method_not_allowed_fallback(|| async {
            ApiError::new(
                StatusCode::METHOD_NOT_ALLOWED,
                ErrorCode::NotFound,
                "Method Not Allowed",
            )
        })
}
