import math

import numpy as np
import pytest

from selene_science.geometry import (
    azimuth_elevation_from_enu,
    deg_to_rad,
    normalize,
    rad_to_deg,
    wrap_azimuth_deg,
    wrap_longitude_deg,
)


def test_deg_rad_roundtrip_scalar_and_array():
    assert deg_to_rad(180.0) == pytest.approx(math.pi)
    assert rad_to_deg(math.pi / 2) == pytest.approx(90.0)
    arr = np.array([-90.0, 0.0, 45.0, 359.0])
    np.testing.assert_allclose(rad_to_deg(deg_to_rad(arr)), arr)
    assert isinstance(deg_to_rad(1.0), float)


@pytest.mark.parametrize(
    ("raw", "wrapped"),
    [
        (0, 0),
        (179.999, 179.999),
        (180, -180),
        (-180, -180),
        (190, -170),
        (-190, 170),
        (540, -180),
        (-1e-17, -1e-17),
        (720.5, 0.5),
    ],
)
def test_wrap_longitude(raw, wrapped):
    out = wrap_longitude_deg(raw)
    assert -180 <= out < 180
    assert out == pytest.approx(wrapped, abs=1e-12)


@pytest.mark.parametrize(
    ("raw", "wrapped"), [(0, 0), (360, 0), (-90, 270), (725, 5), (359.5, 359.5), (-1e-17, 0)]
)
def test_wrap_azimuth(raw, wrapped):
    out = wrap_azimuth_deg(raw)
    assert 0 <= out < 360
    assert out == pytest.approx(wrapped, abs=1e-12)


def test_normalize():
    np.testing.assert_allclose(normalize([3.0, 0.0, 4.0]), [0.6, 0.0, 0.8])
    assert np.linalg.norm(normalize([1e-10, 2e-10, -3e-10])) == pytest.approx(1.0)


@pytest.mark.parametrize("bad", [[0.0, 0.0, 0.0], [np.nan, 1.0, 0.0], [np.inf, 0.0, 0.0]])
def test_normalize_rejects_degenerate(bad):
    with pytest.raises(ValueError):
        normalize(bad)


def test_normalize_rejects_matrix():
    with pytest.raises(ValueError):
        normalize(np.eye(3))


@pytest.mark.parametrize(
    ("enu", "az", "el"),
    [
        ([0, 1, 0], 0.0, 0.0),  # north on horizon
        ([1, 0, 0], 90.0, 0.0),  # east
        ([0, -1, 0], 180.0, 0.0),  # south
        ([-1, 0, 0], 270.0, 0.0),  # west
        ([0, 1, 1], 0.0, 45.0),
        ([1, 0, -1], 90.0, -45.0),
        ([0, 0, 1], 0.0, 90.0),  # zenith: azimuth undefined -> 0 by convention
        ([0, 0, -1], 0.0, -90.0),
    ],
)
def test_azimuth_elevation_from_enu(enu, az, el):
    got_az, got_el = azimuth_elevation_from_enu(enu)
    assert got_az == pytest.approx(az, abs=1e-12)
    assert got_el == pytest.approx(el, abs=1e-12)
