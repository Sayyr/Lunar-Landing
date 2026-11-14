use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub enum NorthSouth {
    N,
    S,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub enum EastWest {
    E,
    W,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SiteQuery {
    pub lat: f64,
    pub ns: NorthSouth,
    pub lon: f64,
    pub ew: EastWest,
    pub height: f64,
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct Coordinates {
    pub lat: f64,
    pub lon: f64,
    pub height: f64,
}

#[derive(Debug, Serialize)]
pub struct Received {
    pub query: SiteQuery,
    pub profile: String,
    pub steps: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct StepResult {
    pub step: String,
    pub output: Value,
}

#[derive(Debug, Serialize)]
pub struct StepError {
    pub step: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "lowercase")]
pub enum Message {
    Received(Received),
    Result(StepResult),
    Error(StepError),
    Done,
}
