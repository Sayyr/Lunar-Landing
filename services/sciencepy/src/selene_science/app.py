"""FastAPI entry point: `uvicorn selene_science.app:app`."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from selene_science import __version__
from selene_science.ephemeris import SpiceEphemerisProvider, SyntheticEphemerisProvider
from selene_science.evaluate import evaluate
from selene_science.models import (
    MAX_SAMPLES,
    EphemerisHealth,
    ErrorBody,
    ErrorDetail,
    ErrorResponse,
    HealthResponse,
    ScenarioRequest,
    ScenarioResponse,
)

_kernel_dir = os.environ.get("SELENE_KERNEL_DIR")
spice_provider = SpiceEphemerisProvider(Path(_kernel_dir) if _kernel_dir else None)
synthetic_provider = SyntheticEphemerisProvider()

app = FastAPI(title="SELENE science service", version=__version__)


def _error(status: int, body: ErrorBody) -> JSONResponse:
    return JSONResponse(status_code=status, content=ErrorResponse(error=body).model_dump())


@app.exception_handler(RequestValidationError)
async def _validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    details = [
        ErrorDetail(field=".".join(str(p) for p in e["loc"] if p != "body"), issue=e["msg"])
        for e in exc.errors()
    ]
    return _error(
        422,
        ErrorBody(code="validation_error", message="Scenario request is invalid.", details=details),
    )


def _too_many_samples(req: ScenarioRequest) -> JSONResponse | None:
    if req.sample_count() <= MAX_SAMPLES:
        return None
    return _error(
        422,
        ErrorBody(
            code="validation_error",
            message="Scenario request is invalid.",
            details=[
                ErrorDetail(
                    field="step_minutes",
                    issue=f"{req.sample_count()} samples exceeds the maximum of {MAX_SAMPLES}",
                )
            ],
        ),
    )


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    s = spice_provider.status()
    return HealthResponse(
        status="ok",
        version=__version__,
        ephemeris=EphemerisHealth(provider=spice_provider.kind, ready=s.ready, reason=s.reason),
    )


# Sync handlers run in FastAPI's threadpool, keeping NumPy/SPICE work off the event loop.
@app.post("/evaluate", response_model=ScenarioResponse)
def evaluate_real(req: ScenarioRequest) -> ScenarioResponse | JSONResponse:
    return _too_many_samples(req) or evaluate(req, spice_provider)


@app.post("/evaluate/synthetic", response_model=ScenarioResponse)
def evaluate_synthetic(req: ScenarioRequest) -> ScenarioResponse | JSONResponse:
    """SYNTHETIC demo data for UI development. Never use for analysis."""
    return _too_many_samples(req) or evaluate(req, synthetic_provider)
