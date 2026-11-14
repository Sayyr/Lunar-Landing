//! Contract tests: shared fixtures and gateway responses vs packages/contracts schemas,
//! plus end-to-end gateway behaviour against an in-process mock science service.

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use http_body_util::BodyExt;
use lunar_landing::envelope::ErrorResponse;
use lunar_landing::gateway::{AppState, SITES_JSON};
use lunar_landing::radio::{RadioLinkRequest, RadioLinkResponse};
use lunar_landing::routes::gateway_router;
use lunar_landing::scenario::{ScenarioRequest, ScenarioResponse, ScenarioStatus};
use lunar_landing::science::ScienceClient;
use lunar_landing::terrain::{SlopeCheckRequest, SlopeCheckResponse, SlopeStatus, SlopeVerdict};
use serde_json::{json, Value};
use tower::ServiceExt;

fn contracts() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/contracts")
}

fn load(rel: &str) -> Value {
    let text =
        std::fs::read_to_string(contracts().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"));
    serde_json::from_str(&text).unwrap()
}

fn validator(schema: &str) -> jsonschema::Validator {
    let mut opts = jsonschema::options().with_draft(jsonschema::Draft::Draft202012);
    for entry in std::fs::read_dir(contracts().join("schemas")).unwrap() {
        let doc: Value =
            serde_json::from_str(&std::fs::read_to_string(entry.unwrap().path()).unwrap()).unwrap();
        let id = doc["$id"].as_str().unwrap().to_owned();
        opts = opts.with_resource(id, jsonschema::Resource::from_contents(doc).unwrap());
    }
    opts.build(&load(&format!("schemas/{schema}"))).unwrap()
}

fn assert_valid(schema: &str, value: &Value) {
    let v = validator(schema);
    let errors: Vec<String> = v
        .iter_errors(value)
        .map(|e| format!("{} at {}", e, e.instance_path))
        .collect();
    assert!(errors.is_empty(), "{schema} violations: {errors:#?}");
}

// ---------- fixtures ----------

#[test]
fn valid_request_fixture_accepted() {
    let raw = load("fixtures/scenario-request.valid.json");
    assert_valid("scenario-request.schema.json", &raw);
    let req: ScenarioRequest = serde_json::from_value(raw).unwrap();
    req.validate().unwrap();
}

#[test]
fn invalid_request_fixtures_rejected() {
    let dir = contracts().join("fixtures/invalid-requests");
    let mut n = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(
            !validator("scenario-request.schema.json").is_valid(&raw),
            "{path:?} schema"
        );
        let rust_ok = serde_json::from_value::<ScenarioRequest>(raw)
            .map(|r| r.validate().is_ok())
            .unwrap_or(false);
        assert!(!rust_ok, "{path:?} should be rejected by the gateway");
        n += 1;
    }
    assert!(n >= 5);
}

#[test]
fn response_fixtures_roundtrip_through_rust_types() {
    for name in [
        "scenario-response.not-ready.json",
        "scenario-response.synthetic.json",
    ] {
        let raw = load(&format!("fixtures/{name}"));
        assert_valid("scenario-response.schema.json", &raw);
        let typed: ScenarioResponse = serde_json::from_value(raw).unwrap();
        assert_valid(
            "scenario-response.schema.json",
            &serde_json::to_value(&typed).unwrap(),
        );
    }
}

#[test]
fn sites_and_error_fixtures() {
    assert_valid(
        "sites-response.schema.json",
        &serde_json::from_str(SITES_JSON).unwrap(),
    );
    let err = load("fixtures/error.validation.json");
    assert_valid("error.schema.json", &err);
    serde_json::from_value::<ErrorResponse>(err).unwrap();
}

#[test]
fn slope_check_request_fixtures() {
    let raw = load("fixtures/slope-check-request.valid.json");
    assert_valid("slope-check-request.schema.json", &raw);
    serde_json::from_value::<SlopeCheckRequest>(raw)
        .unwrap()
        .validate()
        .unwrap();

    let dir = contracts().join("fixtures/invalid-slope-check-requests");
    let mut n = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(
            !validator("slope-check-request.schema.json").is_valid(&raw),
            "{path:?} schema"
        );
        let rust_ok = serde_json::from_value::<SlopeCheckRequest>(raw)
            .map(|r| r.validate().is_ok())
            .unwrap_or(false);
        assert!(!rust_ok, "{path:?} should be rejected by the gateway");
        n += 1;
    }
    assert!(n >= 5);
}

#[test]
fn slope_check_response_fixtures_roundtrip() {
    for name in [
        "slope-check-response.dem-unavailable.json",
        "slope-check-response.synthetic-dem.json",
    ] {
        let raw = load(&format!("fixtures/{name}"));
        assert_valid("slope-check-response.schema.json", &raw);
        let typed: SlopeCheckResponse = serde_json::from_value(raw).unwrap();
        assert_valid(
            "slope-check-response.schema.json",
            &serde_json::to_value(&typed).unwrap(),
        );
    }
}

// ---------- HTTP ----------

async fn mock_science() -> String {
    let not_ready = load("fixtures/scenario-response.not-ready.json");
    let synthetic = load("fixtures/scenario-response.synthetic.json");
    let slope = load("fixtures/slope-check-response.synthetic-dem.json");
    let radio = load("fixtures/radio-link-response.computed.json");
    let app = Router::new()
        .route("/radio/evaluate", post(move || async move { Json(radio) }))
        .route(
            "/health",
            get(|| async {
                Json(
                    json!({"service": "science", "status": "ok", "version": "0.1.0",
                    "ephemeris": {"provider": "spice", "ready": false, "reason": "mock"}}),
                )
            }),
        )
        .route("/evaluate", post(move || async move { Json(not_ready) }))
        .route(
            "/evaluate/synthetic",
            post(move || async move { Json(synthetic) }),
        )
        .route(
            "/terrain/slope/check",
            post(move || async move { Json(slope) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn app(science_url: &str) -> Router {
    Router::new().nest(
        "/api/v1",
        gateway_router(AppState {
            science: ScienceClient::new(science_url, Duration::from_secs(5)),
        }),
    )
}

async fn call(app: Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(
            body.map(|b| Body::from(b.to_string()))
                .unwrap_or_else(Body::empty),
        )
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn health_ok_with_upstream() {
    let url = mock_science().await;
    let (status, body) = call(app(&url), "GET", "/api/v1/health", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert_eq!(body["upstream"]["ephemeris"]["ready"], false);
    assert_valid("health.schema.json", &body);
}

#[tokio::test]
async fn health_degraded_when_science_down() {
    let (status, body) = call(app("http://127.0.0.1:9"), "GET", "/api/v1/health", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "degraded");
    assert!(body["upstream"].is_null());
    assert_valid("health.schema.json", &body);
}

#[tokio::test]
async fn evaluate_forwards_not_ready() {
    let url = mock_science().await;
    let req = load("fixtures/scenario-request.valid.json");
    let (status, body) = call(app(&url), "POST", "/api/v1/scenarios/evaluate", Some(req)).await;
    assert_eq!(status, StatusCode::OK);
    assert_valid("scenario-response.schema.json", &body);
    let typed: ScenarioResponse = serde_json::from_value(body).unwrap();
    assert_eq!(typed.status, ScenarioStatus::NotReady);
    assert!(typed.samples.is_empty());
}

#[tokio::test]
async fn synthetic_route_is_flagged() {
    let url = mock_science().await;
    let req = load("fixtures/scenario-request.valid.json");
    let (status, body) = call(
        app(&url),
        "POST",
        "/api/v1/demo/synthetic/evaluate",
        Some(req),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["synthetic"], true);
    assert_eq!(body["status"], "synthetic");
}

#[tokio::test]
async fn invalid_request_gets_error_envelope_without_calling_science() {
    let mut req = load("fixtures/scenario-request.valid.json");
    req["site"]["latitude_deg"] = json!(-91.0);
    // Unreachable science URL proves validation happens before forwarding.
    let (status, body) = call(
        app("http://127.0.0.1:9"),
        "POST",
        "/api/v1/scenarios/evaluate",
        Some(req),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_valid("error.schema.json", &body);
    assert_eq!(body["error"]["details"][0]["field"], "site.latitude_deg");
}

#[tokio::test]
async fn malformed_json_gets_error_envelope() {
    let (status, body) = call(
        app("http://127.0.0.1:9"),
        "POST",
        "/api/v1/scenarios/evaluate",
        Some(json!({"site": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_valid("error.schema.json", &body);
}

#[tokio::test]
async fn science_down_is_503() {
    let req = load("fixtures/scenario-request.valid.json");
    let (status, body) = call(
        app("http://127.0.0.1:9"),
        "POST",
        "/api/v1/scenarios/evaluate",
        Some(req),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "science_unavailable");
    assert_valid("error.schema.json", &body);
}

#[tokio::test]
async fn sites_endpoint() {
    let (status, body) = call(app("http://127.0.0.1:9"), "GET", "/api/v1/sites", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_valid("sites-response.schema.json", &body);
    assert!(body["sites"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["kind"] == "synthetic_test_point"));
}

#[tokio::test]
async fn slope_check_forwards_science_result() {
    let url = mock_science().await;
    let req = load("fixtures/slope-check-request.valid.json");
    let (status, body) = call(app(&url), "POST", "/api/v1/terrain/slope/check", Some(req)).await;
    assert_eq!(status, StatusCode::OK);
    assert_valid("slope-check-response.schema.json", &body);
    let typed: SlopeCheckResponse = serde_json::from_value(body).unwrap();
    assert_eq!(typed.status, SlopeStatus::Computed);
    assert_eq!(typed.verdict, SlopeVerdict::Pass);
    // the mock serves the SYNTHETIC-DEM fixture; provenance must say so
    assert_eq!(typed.data_provenance.extra["synthetic"], true);
}

#[tokio::test]
async fn slope_check_invalid_is_422_without_calling_science() {
    let mut req = load("fixtures/slope-check-request.valid.json");
    req["zone"]["radius_m"] = json!(5.0);
    let (status, body) = call(
        app("http://127.0.0.1:9"),
        "POST",
        "/api/v1/terrain/slope/check",
        Some(req),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_valid("error.schema.json", &body);
    assert_eq!(body["error"]["details"][0]["field"], "zone.radius_m");
}

#[tokio::test]
async fn slope_check_null_fraction_is_422_without_calling_science() {
    for field in ["required_fraction", "max_nodata_fraction"] {
        let mut req = load("fixtures/slope-check-request.valid.json");
        req[field] = Value::Null;
        let (status, body) = call(
            app("http://127.0.0.1:9"),
            "POST",
            "/api/v1/terrain/slope/check",
            Some(req),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{field}");
        assert_valid("error.schema.json", &body);
        assert_eq!(body["error"]["code"], "validation_error");
    }
}

#[tokio::test]
async fn slope_check_science_down_is_503() {
    let req = load("fixtures/slope-check-request.valid.json");
    let (status, body) = call(
        app("http://127.0.0.1:9"),
        "POST",
        "/api/v1/terrain/slope/check",
        Some(req),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "science_unavailable");
}

// ---------- radio link ----------

#[test]
fn radio_link_request_fixtures() {
    let raw = load("fixtures/radio-link-request.valid.json");
    assert_valid("radio-link-request.schema.json", &raw);
    let req: RadioLinkRequest = serde_json::from_value(raw).unwrap();
    req.validate().unwrap();

    let dir = contracts().join("fixtures/invalid-radio-link-requests");
    let mut count = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(
            !validator("radio-link-request.schema.json").is_valid(&raw),
            "schema accepted {path:?}"
        );
        let typed = serde_json::from_value::<RadioLinkRequest>(raw);
        assert!(
            typed.map(|r| r.validate().is_err()).unwrap_or(true),
            "gateway accepted {path:?}"
        );
        count += 1;
    }
    assert!(count >= 10);
}

#[test]
fn radio_link_response_fixture_roundtrip() {
    let raw = load("fixtures/radio-link-response.computed.json");
    assert_valid("radio-link-response.schema.json", &raw);
    let typed: RadioLinkResponse = serde_json::from_value(raw).unwrap();
    assert_valid(
        "radio-link-response.schema.json",
        &serde_json::to_value(&typed).unwrap(),
    );
    assert_eq!(typed.model.tier, "engineering");
    // never presented as SPICE or as a guaranteed link
    assert_ne!(typed.model.ephemeris_provider, "spice");
    assert!(typed
        .assumptions
        .iter()
        .any(|a| a.contains("not a guaranteed radio link")));
}

#[tokio::test]
async fn radio_link_forwards_science_result() {
    let url = mock_science().await;
    let req = load("fixtures/radio-link-request.valid.json");
    let (status, body) = call(app(&url), "POST", "/api/v1/scenarios/radio-link", Some(req)).await;
    assert_eq!(status, StatusCode::OK);
    assert_valid("radio-link-response.schema.json", &body);
    assert_eq!(body["status"], "computed");
}

#[tokio::test]
async fn radio_link_invalid_is_422_without_calling_science() {
    let mut req = load("fixtures/radio-link-request.valid.json");
    req["link"]["data_rate_bps"] = json!(0);
    let (status, body) = call(
        app("http://127.0.0.1:9"),
        "POST",
        "/api/v1/scenarios/radio-link",
        Some(req),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_valid("error.schema.json", &body);
    assert_eq!(body["error"]["details"][0]["field"], "link.data_rate_bps");

    // a missing hardware figure is refused, never defaulted
    let mut req = load("fixtures/radio-link-request.valid.json");
    req["link"].as_object_mut().unwrap().remove("eirp_dbw");
    let (status, body) = call(
        app("http://127.0.0.1:9"),
        "POST",
        "/api/v1/scenarios/radio-link",
        Some(req),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["error"]["code"], "validation_error");
}

#[tokio::test]
async fn radio_link_science_down_is_503() {
    let req = load("fixtures/radio-link-request.valid.json");
    let (status, body) = call(
        app("http://127.0.0.1:9"),
        "POST",
        "/api/v1/scenarios/radio-link",
        Some(req),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "science_unavailable");
}
