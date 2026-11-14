//! HTTP adapter for the science service. Responses are deserialized into the
//! contract types, so any schema drift surfaces as a 502 instead of reaching clients.

use std::time::Duration;

use axum::http::StatusCode;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::envelope::{ApiError, ErrorCode, ErrorResponse};
use crate::radio::{RadioLinkRequest, RadioLinkResponse};
use crate::scenario::{ScenarioRequest, ScenarioResponse};
use crate::terrain::{SlopeCheckRequest, SlopeCheckResponse};

#[derive(Clone)]
pub struct ScienceClient {
    base_url: String,
    http: reqwest::Client,
    health_http: reqwest::Client,
}

/// Which science endpoint to call. Synthetic is a separate, explicitly flagged route.
#[derive(Debug, Clone, Copy)]
pub enum Provider {
    Real,
    Synthetic,
}

impl ScienceClient {
    pub fn new(base_url: &str, timeout: Duration) -> Self {
        let build = |t| {
            reqwest::Client::builder()
                .timeout(t)
                .build()
                .expect("reqwest client")
        };
        Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            http: build(timeout),
            health_http: build(Duration::from_secs(3)),
        }
    }

    pub async fn health(&self) -> Result<Value, String> {
        let resp = self
            .health_http
            .get(format!("{}/health", self.base_url))
            .send()
            .await
            .map_err(|e| format!("science service unreachable: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("science /health returned {}", resp.status()));
        }
        resp.json()
            .await
            .map_err(|e| format!("invalid health JSON: {e}"))
    }

    pub async fn evaluate(
        &self,
        req: &ScenarioRequest,
        provider: Provider,
    ) -> Result<ScenarioResponse, ApiError> {
        let path = match provider {
            Provider::Real => "/evaluate",
            Provider::Synthetic => "/evaluate/synthetic",
        };
        self.post(path, req).await
    }

    pub async fn slope_check(
        &self,
        req: &SlopeCheckRequest,
    ) -> Result<SlopeCheckResponse, ApiError> {
        self.post("/terrain/slope/check", req).await
    }

    pub async fn radio_link(&self, req: &RadioLinkRequest) -> Result<RadioLinkResponse, ApiError> {
        self.post("/radio/evaluate", req).await
    }

    async fn post<Req: Serialize, Resp: DeserializeOwned>(
        &self,
        path: &str,
        req: &Req,
    ) -> Result<Resp, ApiError> {
        let resp = self
            .http
            .post(format!("{}{path}", self.base_url))
            .json(req)
            .send()
            .await
            .map_err(|e| {
                ApiError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    ErrorCode::ScienceUnavailable,
                    format!("Science service unavailable: {e}"),
                )
            })?;

        let status = resp.status();
        let bytes = resp.bytes().await.map_err(upstream)?;
        if status.is_success() {
            return parse(&bytes);
        }
        // Forward the science service's own error envelope when it is well-formed.
        match serde_json::from_slice::<ErrorResponse>(&bytes) {
            Ok(err) if status.is_client_error() => Err(ApiError {
                status: StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
                body: err.error,
            }),
            _ => Err(ApiError::new(
                StatusCode::BAD_GATEWAY,
                ErrorCode::UpstreamError,
                format!("Science service returned HTTP {status}"),
            )),
        }
    }
}

fn parse<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ApiError> {
    serde_json::from_slice(bytes).map_err(upstream)
}

fn upstream(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        ErrorCode::UpstreamError,
        format!("Science service response did not match the contract: {e}"),
    )
}
