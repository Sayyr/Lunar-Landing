import numpy as np
import pytest

from selene_science.intervals import Interval, extract_intervals


def test_empty():
    assert extract_intervals([], []) == []


def test_never_above():
    assert extract_intervals([0, 1, 2], [-1, -2, -0.5]) == []


def test_always_above_is_clipped_both_ends():
    assert extract_intervals([0, 1, 2], [1, 2, 3]) == [Interval(0, 2, True, True)]


def test_single_interior_interval_interpolated():
    # up-crossing between t=1 (-1) and t=2 (+1) -> 1.5
    # down-crossing between t=3 (+1) and t=4 (-3) -> 3.25
    out = extract_intervals([0, 1, 2, 3, 4], [-2, -1, 1, 1, -3])
    assert len(out) == 1
    assert out[0].start == pytest.approx(1.5)
    assert out[0].end == pytest.approx(3.25)
    assert not out[0].clipped_start and not out[0].clipped_end


def test_multiple_and_clipped():
    out = extract_intervals([0, 1, 2, 3, 4, 5], [1, -1, 1, -1, -1, 1])
    assert [(i.clipped_start, i.clipped_end) for i in out] == [
        (True, False),
        (False, False),
        (False, True),
    ]
    assert out[0].start == 0 and out[-1].end == 5


def test_threshold_and_exact_zero_is_not_above():
    # value == threshold is "not above"
    assert extract_intervals([0, 1, 2], [0, 0, 0]) == []
    out = extract_intervals([0, 10], [1, 3], threshold=2)
    assert out[0].start == pytest.approx(5.0) and out[0].clipped_end


def test_sinusoid_against_analytic_roots():
    t = np.linspace(0, 2 * np.pi, 2001)
    out = extract_intervals(t, np.sin(t + 0.3))
    # sin(t + 0.3) > 0 for t in (0, pi - 0.3) and (2pi - 0.3, 2pi]
    assert out[0].end == pytest.approx(np.pi - 0.3, abs=1e-5)
    assert out[1].start == pytest.approx(2 * np.pi - 0.3, abs=1e-5)


@pytest.mark.parametrize(
    ("t", "v"),
    [([0, 0, 1], [1, 2, 3]), ([0, 2, 1], [1, 2, 3]), ([0, 1], [1]), ([0, 1], [np.nan, 1])],
)
def test_rejects_bad_input(t, v):
    with pytest.raises(ValueError):
        extract_intervals(t, v)
