use std::convert::Infallible;

use axum::{
    body::Body,
    extract::{rejection::JsonRejection, State},
    http::header,
    response::{IntoResponse, Response},
    Json,
};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};

use crate::{
    error::AppError,
    model::{Message, Received, SiteQuery, StepError, StepResult},
    service::SiteService,
};

fn to_line(message: &Message) -> String {
    let mut line = serde_json::to_string(message).unwrap();
    line.push('\n');
    line
}

pub async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

pub async fn site(
    State(service): State<SiteService>,
    body: Result<Json<SiteQuery>, JsonRejection>,
) -> Result<Response, AppError> {
    let Json(query) = body?;
    let plan = service.prepare(&query)?;
    let coordinates = plan.coordinates;
    let concurrency = plan.steps.len();

    let received = to_line(&Message::Received(Received {
        steps: plan.steps.iter().map(|step| step.name.clone()).collect(),
        profile: plan.profile,
        query,
    }));

    let results = stream::iter(plan.steps)
        .map(move |step| {
            let service = service.clone();
            async move {
                let message = match service.run(&step, coordinates).await {
                    Ok(output) => Message::Result(StepResult {
                        step: step.name,
                        output,
                    }),
                    Err(error) => Message::Error(StepError {
                        step: step.name,
                        message: error.message(),
                    }),
                };
                Ok::<_, Infallible>(to_line(&message))
            }
        })
        .buffer_unordered(concurrency);

    let lines = stream::once(async move { Ok::<_, Infallible>(received) })
        .chain(results)
        .chain(stream::once(async { Ok(to_line(&Message::Done)) }));

    Ok((
        [(header::CONTENT_TYPE, "application/x-ndjson")],
        Body::from_stream(lines),
    )
        .into_response())
}
