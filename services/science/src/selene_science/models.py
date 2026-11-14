"""Pydantic models mirroring packages/contracts/schemas/*.json.

The JSON Schemas are the source of truth; tests/test_contracts.py checks that
these models' output validates against them.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SCHEMA_VERSION = "0.1.0"
MAX_SAMPLES = 20_000  # keep in sync with services/api/src/scenario.rs

UTC_PATTERN = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Site(_Strict):
    latitude_deg: float = Field(ge=-90, le=90)
    longitude_deg: float = Field(ge=-180, lt=180)
    observer_height_m: float = Field(ge=0, le=1000)


class ScenarioRequest(_Strict):
    site: Site
    start_utc: str = Field(pattern=UTC_PATTERN)
    duration_hours: float = Field(gt=0, le=2160)
    step_minutes: float = Field(ge=1, le=1440)
    terrain_mode: Literal["ideal", "dem"]

    @field_validator("start_utc")
    @classmethod
    def _parseable(cls, v: str) -> str:
        parse_utc(v)  # raises ValueError on impossible dates like 2026-02-30
        return v

    def start_datetime(self) -> datetime:
        return parse_utc(self.start_utc)

    def sample_count(self) -> int:
        return int(self.duration_hours * 60 // self.step_minutes) + 1


def parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def format_utc(value: datetime) -> str:
    """ISO 8601 UTC with millisecond precision and a 'Z' suffix."""
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Direction(_Strict):
    azimuth_deg: float = Field(ge=0, lt=360)
    elevation_deg: float = Field(ge=-90, le=90)


class Sample(_Strict):
    utc: str
    sun: Direction
    earth: Direction


class Window(_Strict):
    start_utc: str
    end_utc: str
    clipped_start: bool
    clipped_end: bool


class Windows(_Strict):
    sun_visible: list[Window] = []
    earth_visible: list[Window] = []


class Provenance(_Strict):
    name: str
    kind: Literal["spice_kernel", "dem", "synthetic", "other"]
    source: str
    version: str | None = None
    license: str | None = None
    notes: str


class ModelInfo(_Strict):
    ephemeris_provider: Literal["spice", "synthetic_fixture"]
    horizon_model: Literal["ideal_geometric", "dem_terrain"]
    body_fixed_frame: str | None
    time_scale_note: str
    kernel_set: list[str] = []


class ScenarioResponse(_Strict):
    schema_version: Literal["0.1.0"] = SCHEMA_VERSION
    status: Literal["computed", "synthetic", "not_ready"]
    synthetic: bool
    message: str
    request: ScenarioRequest
    model: ModelInfo
    data_provenance: list[Provenance]
    assumptions: list[str]
    warnings: list[str]
    samples: list[Sample]
    windows: Windows


class ErrorDetail(_Strict):
    field: str
    issue: str


class ErrorBody(_Strict):
    code: Literal[
        "validation_error", "not_found", "science_unavailable", "upstream_error", "internal_error"
    ]
    message: str
    details: list[ErrorDetail] = []


class ErrorResponse(_Strict):
    error: ErrorBody


class EphemerisHealth(_Strict):
    provider: str
    ready: bool
    reason: str


class HealthResponse(_Strict):
    service: Literal["science"] = "science"
    status: Literal["ok", "degraded"]
    version: str
    ephemeris: EphemerisHealth
