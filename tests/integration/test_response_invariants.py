"""Offline output checks on the shared response fixtures, plus mutation tests.

Each mutation injects one known defect into a copy of the shared synthetic fixture. The bench
must detect it. This proves the checks used by the live tests actually bite.
"""

from __future__ import annotations

import copy

import pytest

from bench import invariants as inv
from bench.contracts import SHARED_FIXTURES, load_json, schema_errors

SYNTHETIC = load_json(SHARED_FIXTURES / "scenario-response.synthetic.json")
NOT_READY = load_json(SHARED_FIXTURES / "scenario-response.not-ready.json")


@pytest.mark.parametrize("name,resp", [("synthetic", SYNTHETIC), ("not_ready", NOT_READY)])
def test_shared_response_fixture_passes_all_invariants(name, resp):
    assert inv.check_all(resp) == []


def test_synthetic_fixture_is_conspicuously_labelled():
    assert SYNTHETIC["status"] == "synthetic" and SYNTHETIC["synthetic"] is True
    assert SYNTHETIC["model"]["ephemeris_provider"] == "synthetic_fixture"
    assert "SYNTHETIC" in SYNTHETIC["message"]


def test_not_ready_fixture_carries_no_numbers():
    assert NOT_READY["samples"] == []
    assert NOT_READY["windows"] == {"sun_visible": [], "earth_visible": []}


def test_sample_count_rule_examples():
    # docs/validation.md examples, checked against the documented formula only.
    r = {"duration_hours": 1, "step_minutes": 7}
    assert inv.expected_sample_count(r) == 9
    assert inv.expected_sample_count({"duration_hours": 72, "step_minutes": 10}) == 433
    assert inv.expected_sample_count({"duration_hours": 1 / 60, "step_minutes": 1}) == 2


def test_parse_utc_accepts_contract_forms_only():
    assert inv.parse_utc("2026-11-15T00:00:00Z").isoformat() == "2026-11-15T00:00:00+00:00"
    assert inv.parse_utc("2026-11-15T00:00:00.1234567Z").microsecond == 123456
    for bad in ("2026-11-15T00:00:00", "2026-11-15T00:00:00+00:00", "2026-11-15 00:00:00Z"):
        with pytest.raises(ValueError):
            inv.parse_utc(bad)


# --- mutations ----------------------------------------------------------------------------


def _set(path, value):
    def apply(r):
        node = r
        for key in path[:-1]:
            node = node[key]
        node[path[-1]] = value

    return apply


def _drop_sample(r):
    del r["samples"][3]


def _swap_samples(r):
    r["samples"][1]["utc"], r["samples"][2]["utc"] = r["samples"][2]["utc"], r["samples"][1]["utc"]


def _shift_window(r):
    r["windows"]["sun_visible"][1]["start_utc"] = r["samples"][1]["utc"]


def _extra_window(r):
    r["windows"]["earth_visible"].append(copy.deepcopy(r["windows"]["earth_visible"][0]))


def _flip_elevation(r):
    # Turn a visible sample invisible without touching the windows.
    r["samples"][1]["sun"]["elevation_deg"] = -abs(r["samples"][1]["sun"]["elevation_deg"]) - 1


def _no_disclaimer(r):
    r["assumptions"] = [a for a in r["assumptions"] if "power" not in a.lower()]


def _no_warning(r):
    r["warnings"] = [w for w in r["warnings"] if "SYNTHETIC" not in w]


MUTATIONS = {
    "synthetic flag cleared": _set(["synthetic"], False),
    "status claims computed": _set(["status"], "computed"),
    "provider claims spice": _set(["model", "ephemeris_provider"], "spice"),
    "SYNTHETIC warning removed": _no_warning,
    "power/radio disclaimer removed": _no_disclaimer,
    "horizon model mismatches terrain_mode": _set(["model", "horizon_model"], "dem_terrain"),
    "sample dropped": _drop_sample,
    "samples out of order": _swap_samples,
    "sample has offset timestamp": _set(["samples", 0, "utc"], "2026-11-15T00:00:00+00:00"),
    "azimuth out of range": _set(["samples", 2, "earth", "azimuth_deg"], 360.0),
    "elevation out of range": _set(["samples", 2, "earth", "elevation_deg"], 91.0),
    "window edge not bracketed": _shift_window,
    "duplicate window": _extra_window,
    "window clipped flag wrong": _set(["windows", "sun_visible", 0, "clipped_start"], False),
    "elevation contradicts window": _flip_elevation,
    "not_ready with samples": lambda r: r.update(status="not_ready", synthetic=False),
}


@pytest.mark.parametrize("name", sorted(MUTATIONS))
def test_bench_detects_injected_defect(name):
    resp = copy.deepcopy(SYNTHETIC)
    MUTATIONS[name](resp)
    found = inv.check_all(resp) + schema_errors("response", resp)
    assert found, f"bench did not detect: {name}"


def test_request_echo_mismatch_is_detected():
    sent = copy.deepcopy(SYNTHETIC["request"])
    sent["site"]["latitude_deg"] = -85.0
    assert inv.check_request_echo(SYNTHETIC, sent)


def test_plausibility_bounds_only_apply_to_computed():
    assert inv.check_physical_plausibility(SYNTHETIC) == []


def test_plausibility_bounds_reject_gross_errors():
    # A "computed" copy of the synthetic waveforms: its 20° swings at |lat| = 89.5° are impossible
    # for the real Sun, so the plausibility check must flag them.
    resp = copy.deepcopy(SYNTHETIC)
    resp["status"] = "computed"
    assert inv.check_physical_plausibility(resp)


# --- DEM terrain horizon fixture -----------------------------------------------------------

SYNTHETIC_DEM = load_json(SHARED_FIXTURES / "scenario-response.synthetic-dem.json")


def test_terrain_fixture_is_consistent():
    assert inv.check_all(SYNTHETIC_DEM) == []
    assert SYNTHETIC_DEM["synthetic"] is True, "synthetic DEM fixture must be flagged"


def _drop_terrain(r):
    del r["terrain_horizon"]


def _shift_horizon(r):
    r["samples"][0]["sun"]["horizon_elevation_deg"] += 1.0


def _drop_sample_horizon(r):
    del r["samples"][1]["earth"]["horizon_elevation_deg"]


def _raise_all_horizons(r):
    # windows no longer match "elevation above the terrain horizon"
    for s in r["samples"]:
        s["sun"]["horizon_elevation_deg"] = 80.0
        s["earth"]["horizon_elevation_deg"] = 80.0
    r["terrain_horizon"]["elevation_deg"] = [80.0] * len(r["terrain_horizon"]["elevation_deg"])


@pytest.mark.parametrize("mutate", [_drop_terrain, _shift_horizon, _drop_sample_horizon, _raise_all_horizons], ids=lambda f: f.__name__)
def test_terrain_checks_detect_injected_defects(mutate):
    resp = copy.deepcopy(SYNTHETIC_DEM)
    mutate(resp)
    assert inv.check_all(resp), f"{mutate.__name__} went undetected"


def test_ideal_response_must_not_carry_terrain_data():
    resp = copy.deepcopy(SYNTHETIC)
    resp["samples"][0]["sun"]["horizon_elevation_deg"] = 1.0
    assert inv.check_all(resp)
