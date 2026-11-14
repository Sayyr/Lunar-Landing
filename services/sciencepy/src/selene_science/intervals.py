"""Extract above-threshold intervals from a sampled time series.

Edges are located by linear interpolation between the two samples that bracket a
threshold crossing. Events shorter than the sampling step can be missed entirely;
callers must surface that limitation (see docs/validation.md).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import ArrayLike


@dataclass(frozen=True)
class Interval:
    start: float
    end: float
    clipped_start: bool  # interval was already open at the first sample
    clipped_end: bool  # interval was still open at the last sample


def _crossing(t0: float, t1: float, v0: float, v1: float, threshold: float) -> float:
    if v1 == v0:
        return t0
    return t0 + (threshold - v0) * (t1 - t0) / (v1 - v0)


def extract_intervals(
    times: ArrayLike, values: ArrayLike, threshold: float = 0.0
) -> list[Interval]:
    """Return maximal intervals where ``values > threshold``.

    ``times`` must be strictly increasing (any monotonic numeric scale, e.g. seconds).
    """
    t = np.asarray(times, dtype=np.float64)
    v = np.asarray(values, dtype=np.float64)
    if t.shape != v.shape or t.ndim != 1:
        raise ValueError("times and values must be 1-D arrays of equal length")
    if t.size == 0:
        return []
    if not (np.all(np.isfinite(t)) and np.all(np.isfinite(v))):
        raise ValueError("times and values must be finite")
    if t.size > 1 and np.any(np.diff(t) <= 0):
        raise ValueError("times must be strictly increasing")

    above = v > threshold
    intervals: list[Interval] = []
    start: float | None = float(t[0]) if above[0] else None
    clipped_start = bool(above[0])

    for i in range(1, t.size):
        if above[i] and not above[i - 1]:
            start = _crossing(t[i - 1], t[i], v[i - 1], v[i], threshold)
            clipped_start = False
        elif not above[i] and above[i - 1]:
            assert start is not None
            end = _crossing(t[i - 1], t[i], v[i - 1], v[i], threshold)
            intervals.append(Interval(start, end, clipped_start, False))
            start = None

    if start is not None:
        intervals.append(Interval(start, float(t[-1]), clipped_start, True))
    return intervals
