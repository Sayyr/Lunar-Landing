//! Error envelope matching `packages/contracts/schemas/error.schema.json`.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ValidationError,
    NotFound,
    ScienceUnavailable,
    UpstreamError,
    InternalError,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldIssue {
    pub field: String,
    pub issue: String,
}

impl FieldIssue {
    pub fn new(field: &str, issue: &str) -> Self {
        Self {
            field: field.into(),
            issue: issue.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorBody {
    pub code: ErrorCode,
    pub message: String,
    pub details: Vec<FieldIssue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorResponse {
    pub error: ErrorBody,
}

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub body: ErrorBody,
}

impl ApiError {
    pub fn new(status: StatusCode, code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ErrorBody {
                code,
                message: message.into(),
                details: Vec::new(),
            },
        }
    }

    pub fn validation(details: Vec<FieldIssue>) -> Self {
        let mut e = Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            ErrorCode::ValidationError,
            "Scenario request is invalid.",
        );
        e.body.details = details;
        e
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(ErrorResponse { error: self.body })).into_response()
    }
}
