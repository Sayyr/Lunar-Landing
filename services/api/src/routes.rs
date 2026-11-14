use axum::{
    routing::{get, post},
    Router,
};

use crate::{
    gateway::{self, AppState},
    handler,
    service::SiteService,
};

pub fn site_router(service: SiteService) -> Router {
    Router::new()
        .route("/health", get(handler::health))
        .route("/calcule", post(handler::site))
        .with_state(service)
}

pub fn gateway_router(state: AppState) -> Router {
    Router::new()
        .route("/sites", get(gateway::sites))
        .route("/scenarios/evaluate", post(gateway::evaluate_real))
        .route(
            "/demo/synthetic/evaluate",
            post(gateway::evaluate_synthetic),
        )
        .with_state(state)
}

pub fn router(service: SiteService, state: AppState) -> Router {
    Router::new().nest("/api/v1", site_router(service).merge(gateway_router(state)))
}
