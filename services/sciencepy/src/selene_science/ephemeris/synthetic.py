"""SYNTHETIC fixture provider — outputs have NO physical meaning.

Produces smooth, deterministic, arbitrary waveforms so the UI, contracts and
window extraction can be exercised before real ephemerides exist. Periods and
amplitudes are deliberately arbitrary (not lunar synodic/libration values) so
nobody mistakes them for physics.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import datetime

import numpy as np

from selene_science.ephemeris.base import DirectionSeries, EphemerisProvider, ProviderStatus
from selene_science.geometry import wrap_azimuth_deg
from selene_science.models import ModelInfo, Provenance, Site

SUN_PERIOD_H = 36.0
EARTH_PERIOD_H = 60.0


class SyntheticEphemerisProvider(EphemerisProvider):
    kind = "synthetic_fixture"
    synthetic = True

    def status(self) -> ProviderStatus:
        return ProviderStatus(ready=True, reason="synthetic waveforms, no physical meaning")

    def model_info(self) -> ModelInfo:
        return ModelInfo(
            ephemeris_provider="synthetic_fixture",
            horizon_model="ideal_geometric",
            body_fixed_frame=None,
            time_scale_note="Synthetic: UTC sample times only; no time-scale conversion performed.",
            kernel_set=[],
        )

    def provenance(self) -> list[Provenance]:
        return [
            Provenance(
                name="SELENE synthetic waveform generator",
                kind="synthetic",
                source="services/science/src/selene_science/ephemeris/synthetic.py",
                version="0.1.0",
                license=None,
                notes="Arbitrary sinusoids. Not derived from any ephemeris, kernel or DEM.",
            )
        ]

    def assumptions(self) -> list[str]:
        return [
            "SYNTHETIC: azimuth/elevation are arbitrary sinusoids "
            f"(Sun period {SUN_PERIOD_H} h, Earth period {EARTH_PERIOD_H} h) chosen only to "
            "exercise the UI. They do not represent the Sun or Earth.",
            "SYNTHETIC: waveform phase depends on site longitude only so two scenarios look "
            "different; this dependence is not physical.",
        ]

    def directions(self, site: Site, times_utc: Sequence[datetime]) -> DirectionSeries:
        t0 = times_utc[0]
        hours = np.array([(t - t0).total_seconds() / 3600.0 for t in times_utc])
        phase = math.radians(site.longitude_deg)
        sun_arg = 2 * np.pi * hours / SUN_PERIOD_H + phase
        earth_arg = 2 * np.pi * hours / EARTH_PERIOD_H + phase / 2
        return DirectionSeries(
            sun_azimuth_deg=np.asarray(wrap_azimuth_deg(np.degrees(sun_arg))),
            sun_elevation_deg=3.0 * np.sin(sun_arg) + 0.5,
            earth_azimuth_deg=np.asarray(wrap_azimuth_deg(180.0 + 5.0 * np.sin(earth_arg))),
            earth_elevation_deg=2.0 * np.sin(earth_arg),
        )
