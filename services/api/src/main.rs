use std::{path::PathBuf, process::exit, time::Duration};

use lunar_landing::{
    config::ProfilesConfig, gateway::AppState, repository::CalculatorRepository, routes,
    science::ScienceClient, service::SiteService,
};
use tokio::{
    net::TcpListener,
    signal::unix::{signal, SignalKind},
};

const ADDRESS: &str = "0.0.0.0:3000";
const DEFAULT_PROFILES_FILE: &str = "/etc/lunar-landing/profiles.json";
const DEFAULT_SCRIPTS_DIR: &str = "/usr/local/lib/lunar-landing";
const DEFAULT_SCIENCE_URL: &str = "http://127.0.0.1:8000";
const DEFAULT_SCIENCE_TIMEOUT_S: &str = "30";

fn env_path(name: &str, default: &str) -> PathBuf {
    PathBuf::from(std::env::var(name).unwrap_or_else(|_| default.into()))
}

async fn shutdown_signal() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let terminate = async {
        match signal(SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        _ = interrupt => {}
        _ = terminate => {}
    }
}

#[tokio::main]
async fn main() {
    let profiles_file = env_path("PROFILES_FILE", DEFAULT_PROFILES_FILE);
    let scripts_dir = env_path("SCRIPTS_DIR", DEFAULT_SCRIPTS_DIR);
    let config = match ProfilesConfig::load(&profiles_file, scripts_dir) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            exit(1);
        }
    };
    let service = SiteService::new(config, CalculatorRepository);

    let science_url =
        std::env::var("SELENE_SCIENCE_URL").unwrap_or_else(|_| DEFAULT_SCIENCE_URL.into());
    let timeout_s: u64 = match std::env::var("SELENE_SCIENCE_TIMEOUT_S")
        .unwrap_or_else(|_| DEFAULT_SCIENCE_TIMEOUT_S.into())
        .parse()
    {
        Ok(timeout_s) => timeout_s,
        Err(_) => {
            eprintln!("SELENE_SCIENCE_TIMEOUT_S must be an integer number of seconds");
            exit(1);
        }
    };
    let state = AppState {
        science: ScienceClient::new(&science_url, Duration::from_secs(timeout_s)),
    };

    let listener = match TcpListener::bind(ADDRESS).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("cannot bind {ADDRESS}: {error}");
            exit(1);
        }
    };

    println!("listening on {ADDRESS}");
    if let Err(error) = axum::serve(listener, routes::router(service, state))
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        eprintln!("server error: {error}");
        exit(1);
    }
}
