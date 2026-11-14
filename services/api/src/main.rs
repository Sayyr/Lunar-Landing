use std::time::Duration;

use selene_api::science::ScienceClient;
use selene_api::{router, AppState};
use tracing_subscriber::EnvFilter;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let bind = env_or("SELENE_API_BIND", "127.0.0.1:8080");
    let science_url = env_or("SELENE_SCIENCE_URL", "http://127.0.0.1:8000");
    let timeout_s: u64 = env_or("SELENE_SCIENCE_TIMEOUT_S", "30")
        .parse()
        .expect("SELENE_SCIENCE_TIMEOUT_S must be an integer number of seconds");

    let state = AppState {
        science: ScienceClient::new(&science_url, Duration::from_secs(timeout_s)),
    };
    let listener = tokio::net::TcpListener::bind(&bind)
        .await
        .unwrap_or_else(|e| panic!("cannot bind {bind}: {e}"));
    tracing::info!(%bind, %science_url, "selene-api listening");
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server error");
}
