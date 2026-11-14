use axum::{
    extract::rejection::JsonRejection,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug)]
pub enum AppError {
    InvalidBody(JsonRejection),
    Validation(String),
    Calculator(String),
}

impl AppError {
    pub fn message(&self) -> String {
        match self {
            AppError::InvalidBody(rejection) => rejection.body_text(),
            AppError::Validation(message) | AppError::Calculator(message) => message.clone(),
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            AppError::InvalidBody(rejection) => rejection.status(),
            AppError::Validation(_) => StatusCode::UNPROCESSABLE_ENTITY,
            AppError::Calculator(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl From<JsonRejection> for AppError {
    fn from(rejection: JsonRejection) -> Self {
        AppError::InvalidBody(rejection)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.status(), Json(json!({ "error": self.message() }))).into_response()
    }
}
