"""Pure geometry helpers.

Conventions (see docs/validation.md):
- Public JSON uses degrees; internal computations use radians. Convert only at the boundary.
- Longitude is east-positive, wrapped to [-180, 180).
- Azimuth is measured from local north toward east, wrapped to [0, 360).
"""

from __future__ import annotations

import math

import numpy as np
from numpy.typing import ArrayLike, NDArray

# Vectors with a norm below this are treated as zero (direction undefined).
ZERO_NORM_TOL = 1e-15


def deg_to_rad(value: ArrayLike) -> NDArray[np.float64] | float:
    out = np.deg2rad(np.asarray(value, dtype=np.float64))
    return float(out) if out.ndim == 0 else out


def rad_to_deg(value: ArrayLike) -> NDArray[np.float64] | float:
    out = np.rad2deg(np.asarray(value, dtype=np.float64))
    return float(out) if out.ndim == 0 else out


def wrap_longitude_deg(value: ArrayLike) -> NDArray[np.float64] | float:
    """Wrap to [-180, 180). +180 maps to -180."""
    v = np.asarray(value, dtype=np.float64)
    out = np.mod(v + 180.0, 360.0) - 180.0
    # np.mod can return 360.0 for tiny negative inputs due to rounding; fold it back.
    out = np.where(out >= 180.0, out - 360.0, out)
    return float(out) if out.ndim == 0 else out


def wrap_azimuth_deg(value: ArrayLike) -> NDArray[np.float64] | float:
    """Wrap to [0, 360)."""
    v = np.asarray(value, dtype=np.float64)
    out = np.mod(v, 360.0)
    out = np.where(out >= 360.0, out - 360.0, out)
    return float(out) if out.ndim == 0 else out


def normalize(vector: ArrayLike) -> NDArray[np.float64]:
    """Return the unit vector. Raises ValueError for (near-)zero or non-finite vectors."""
    v = np.asarray(vector, dtype=np.float64)
    if v.ndim != 1:
        raise ValueError(f"expected a 1-D vector, got shape {v.shape}")
    if not np.all(np.isfinite(v)):
        raise ValueError("vector contains non-finite components")
    norm = float(np.linalg.norm(v))
    if norm < ZERO_NORM_TOL:
        raise ValueError("cannot normalize a zero-length vector")
    return v / norm


def azimuth_elevation_from_enu(enu: ArrayLike) -> tuple[float, float]:
    """Azimuth/elevation (degrees) of a direction expressed in a local East-North-Up frame.

    Building the ENU frame itself (and its polar convention) is the ephemeris
    provider's job; this helper only converts an already-local vector.
    For a direction exactly along Up/Down, azimuth is undefined and returned as 0.0.
    """
    e, n, u = normalize(enu)
    horizontal = math.hypot(e, n)
    elevation = math.degrees(math.atan2(u, horizontal))
    azimuth = (
        0.0
        if horizontal < ZERO_NORM_TOL
        else float(wrap_azimuth_deg(math.degrees(math.atan2(e, n))))
    )
    return azimuth, elevation
