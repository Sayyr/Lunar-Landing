"""Ephemeris provider abstraction.

A provider turns (site, UTC sample times) into apparent Sun/Earth directions in
the observer's local frame. Providers own every frame/time conversion; callers
only ever see degrees and UTC.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

import numpy as np
from numpy.typing import NDArray

from selene_science.models import ModelInfo, Provenance, Site


class EphemerisNotReady(RuntimeError):
    """The provider cannot compute (missing kernels, not implemented, ...)."""


@dataclass(frozen=True)
class ProviderStatus:
    ready: bool
    reason: str


@dataclass(frozen=True)
class DirectionSeries:
    """Per-sample topocentric directions, degrees. All arrays have len(times)."""

    sun_azimuth_deg: NDArray[np.float64]
    sun_elevation_deg: NDArray[np.float64]
    earth_azimuth_deg: NDArray[np.float64]
    earth_elevation_deg: NDArray[np.float64]


class EphemerisProvider(ABC):
    #: Matches ModelInfo.ephemeris_provider.
    kind: str
    #: True if outputs carry no physical meaning. Propagated to ScenarioResponse.synthetic.
    synthetic: bool

    @abstractmethod
    def status(self) -> ProviderStatus: ...

    @abstractmethod
    def model_info(self) -> ModelInfo: ...

    @abstractmethod
    def provenance(self) -> list[Provenance]: ...

    @abstractmethod
    def assumptions(self) -> list[str]: ...

    @abstractmethod
    def directions(self, site: Site, times_utc: Sequence[datetime]) -> DirectionSeries:
        """Raise EphemerisNotReady if the provider cannot compute."""
