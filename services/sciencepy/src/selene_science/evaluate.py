"""Scenario evaluation: time grid -> provider directions -> visibility windows."""

from __future__ import annotations

from datetime import datetime, timedelta

import numpy as np

from selene_science.ephemeris import EphemerisNotReady, EphemerisProvider
from selene_science.intervals import Interval, extract_intervals
from selene_science.models import (
    Direction,
    ModelInfo,
    Sample,
    ScenarioRequest,
    ScenarioResponse,
    Window,
    Windows,
    format_utc,
)

POLAR_WARNING_LAT_DEG = 89.0

IDEAL_HORIZON_ASSUMPTIONS = [
    "Horizon model: ideal geometric horizon (elevation 0 deg); local terrain is ignored.",
    "Visibility = body centre above the horizon; finite apparent disks (partial Sun/Earth) "
    "are not modelled.",
    "Window edges are linearly interpolated between samples; events shorter than the "
    "sampling step may be missed.",
    "Geometric visibility only: Sun visibility is not a power guarantee and Earth visibility "
    "is not a radio-link guarantee.",
]


def sample_times(request: ScenarioRequest) -> list[datetime]:
    start = request.start_datetime()
    step = timedelta(minutes=request.step_minutes)
    return [start + i * step for i in range(request.sample_count())]


def _warnings(request: ScenarioRequest, provider: EphemerisProvider) -> list[str]:
    out: list[str] = []
    if provider.synthetic:
        out.append("SYNTHETIC DATA: these numbers do not describe the real Sun or Earth.")
    if abs(request.site.latitude_deg) >= POLAR_WARNING_LAT_DEG:
        out.append(
            f"|latitude| >= {POLAR_WARNING_LAT_DEG} deg: local north/azimuth is ill-conditioned "
            "near the pole; the deterministic polar azimuth convention is not implemented yet."
        )
    return out


def _windows(t0: datetime, seconds: np.ndarray, elevation_deg: np.ndarray) -> list[Window]:
    def to_window(iv: Interval) -> Window:
        return Window(
            start_utc=format_utc(t0 + timedelta(seconds=iv.start)),
            end_utc=format_utc(t0 + timedelta(seconds=iv.end)),
            clipped_start=iv.clipped_start,
            clipped_end=iv.clipped_end,
        )

    return [to_window(iv) for iv in extract_intervals(seconds, elevation_deg, threshold=0.0)]


def not_ready(
    request: ScenarioRequest, model: ModelInfo, message: str, warnings: list[str]
) -> ScenarioResponse:
    return ScenarioResponse(
        status="not_ready",
        synthetic=False,
        message=message,
        request=request,
        model=model,
        data_provenance=[],
        assumptions=[],
        warnings=warnings,
        samples=[],
        windows=Windows(),
    )


def evaluate(request: ScenarioRequest, provider: EphemerisProvider) -> ScenarioResponse:
    model = provider.model_info()
    warnings = _warnings(request, provider)

    if request.terrain_mode == "dem":
        model = model.model_copy(update={"horizon_model": "dem_terrain"})
        return not_ready(
            request, model, "DEM terrain horizon is not available yet (no DEM installed).", warnings
        )

    times = sample_times(request)
    try:
        d = provider.directions(request.site, times)
    except EphemerisNotReady as exc:
        return not_ready(request, model, f"Ephemerides not available: {exc}", warnings)

    t0 = times[0]
    seconds = np.array([(t - t0).total_seconds() for t in times])
    samples = [
        Sample(
            utc=format_utc(t),
            sun=Direction(
                azimuth_deg=float(d.sun_azimuth_deg[i]), elevation_deg=float(d.sun_elevation_deg[i])
            ),
            earth=Direction(
                azimuth_deg=float(d.earth_azimuth_deg[i]),
                elevation_deg=float(d.earth_elevation_deg[i]),
            ),
        )
        for i, t in enumerate(times)
    ]
    return ScenarioResponse(
        status="synthetic" if provider.synthetic else "computed",
        synthetic=provider.synthetic,
        message=(
            "SYNTHETIC fixture output for UI development only."
            if provider.synthetic
            else "Computed from SPICE ephemerides."
        ),
        request=request,
        model=model,
        data_provenance=provider.provenance(),
        assumptions=provider.assumptions() + IDEAL_HORIZON_ASSUMPTIONS,
        warnings=warnings,
        samples=samples,
        windows=Windows(
            sun_visible=_windows(t0, seconds, d.sun_elevation_deg),
            earth_visible=_windows(t0, seconds, d.earth_elevation_deg),
        ),
    )
