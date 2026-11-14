"""SPICE-backed ephemeris provider — NOT IMPLEMENTED YET.

Planned pipeline (next task, see docs/validation.md):
1. Load a meta-kernel listing LSK (naif00NN.tls), PCK (pck000NN.tpc + moon_pa_*.bpc),
   FK (moon_*.tf), and SPK (de4xx.bsp) from SELENE_KERNEL_DIR.
2. UTC -> ET (TDB seconds past J2000) via spiceypy.str2et using the LSK.
3. Observer: planetocentric lat/lon (deg -> rad) and radius (reference radius + height,
   m -> km) in the chosen body-fixed frame via spiceypy.latrec. Proposed frame: MOON_ME
   (LOLA products use the mean-Earth/polar-axis system) — confirm against DEM metadata.
4. Sun/Earth apparent positions from the observer: spkcpo(target, et, frame, 'OBSERVER',
   abcorr='LT+S', obspos, 'MOON', frame).
5. Rotate to local ENU, then azimuth/elevation; deterministic polar convention.

Until then this provider reports itself as not ready and refuses to compute.
"""

from __future__ import annotations

import importlib.util
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path

from selene_science.ephemeris.base import (
    DirectionSeries,
    EphemerisNotReady,
    EphemerisProvider,
    ProviderStatus,
)
from selene_science.models import ModelInfo, Provenance, Site


class SpiceEphemerisProvider(EphemerisProvider):
    kind = "spice"
    synthetic = False

    def __init__(self, kernel_dir: Path | None) -> None:
        self.kernel_dir = kernel_dir

    def status(self) -> ProviderStatus:
        reasons = ["SPICE provider not implemented yet"]
        if importlib.util.find_spec("spiceypy") is None:
            reasons.append("spiceypy not installed (pip install -e '.[spice]')")
        if self.kernel_dir is None:
            reasons.append("SELENE_KERNEL_DIR not set")
        elif not self.kernel_dir.is_dir():
            reasons.append(f"kernel directory {self.kernel_dir} does not exist")
        return ProviderStatus(ready=False, reason="; ".join(reasons))

    def model_info(self) -> ModelInfo:
        return ModelInfo(
            ephemeris_provider="spice",
            horizon_model="ideal_geometric",
            body_fixed_frame=None,
            time_scale_note="UTC at the API boundary; ET (TDB) via LSK once implemented.",
            kernel_set=[],
        )

    def provenance(self) -> list[Provenance]:
        return []

    def assumptions(self) -> list[str]:
        return []

    def directions(self, site: Site, times_utc: Sequence[datetime]) -> DirectionSeries:
        raise EphemerisNotReady(self.status().reason)
