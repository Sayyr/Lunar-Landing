use axum::{
    routing::{get, post},
    Router,
};

use crate::{handler, service::SiteService};

pub fn router(service: SiteService) -> Router {
    let api = Router::new()
        .route("/health", get(handler::health))
        .route("/site", post(handler::site));

    Router::new().nest("/api/v1", api).with_state(service)
}
