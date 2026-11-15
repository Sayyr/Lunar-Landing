"""Static contract checks: shared schemas, fixtures, and drift between the three implementations.

Source files of the other services are only *read* (enum literals, constants). Nothing is imported
or executed from them.
"""

from __future__ import annotations

import re

import pytest
from jsonschema import Draft202012Validator

from bench.contracts import (
    REPO,
    SCHEMA_FILES,
    SCHEMAS,
    SHARED_FIXTURES,
    load_json,
    schema,
    schema_errors,
)
from conftest import CASES, contract_gap, scenario

TS_TYPES = REPO / "apps/web/src/api/types.ts"
TS_CELESTIAL = REPO / "apps/web/src/api/celestialTypes.ts"
RUST_SCENARIO = REPO / "services/api/src/scenario.rs"
RUST_ERROR = REPO / "services/api/src/envelope.rs"
RUST_LIB = REPO / "services/api/src/lib.rs"
CPP_MODELS = REPO / "services/science/src/models.hpp"


def read(path):
    if not path.is_file():
        pytest.fail(f"{path.relative_to(REPO)} not found: the bench needs updating")
    return path.read_text(encoding="utf-8")


# --- schemas and shared fixtures ----------------------------------------------------------


@pytest.mark.parametrize("kind", sorted(SCHEMA_FILES))
def test_schema_is_valid_draft_2020_12(kind):
    Draft202012Validator.check_schema(schema(kind))


def test_every_schema_file_is_known_to_the_bench():
    on_disk = {p.name for p in SCHEMAS.glob("*.schema.json")}
    assert on_disk == set(SCHEMA_FILES.values()), "new/removed schema: update bench/contracts.py"


@pytest.mark.parametrize(
    "kind,fixture",
    [
        ("request", "scenario-request.valid.json"),
        ("response", "scenario-response.not-ready.json"),
        ("response", "scenario-response.synthetic.json"),
        ("response", "scenario-response.synthetic-dem.json"),
        ("sites", "sites.json"),
        ("error", "error.validation.json"),
        ("slope_request", "slope-check-request.valid.json"),
        ("slope_response", "slope-check-response.dem-unavailable.json"),
        ("slope_response", "slope-check-response.synthetic-dem.json"),
        ("celestial_request", "celestial-state-request.valid.json"),
        ("celestial_response", "celestial-state-response.computed.json"),
        ("radio_request", "radio-link-request.valid.json"),
        ("radio_response", "radio-link-response.computed.json"),
    ],
)
def test_shared_fixture_matches_schema(kind, fixture):
    assert schema_errors(kind, load_json(SHARED_FIXTURES / fixture)) == []


@pytest.mark.parametrize(
    "path", sorted((SHARED_FIXTURES / "invalid-requests").glob("*.json")), ids=lambda p: p.stem
)
def test_shared_invalid_request_is_rejected_by_schema(path):
    assert schema_errors("request", load_json(path)), f"{path.name} is accepted by the schema"


@pytest.mark.parametrize(
    "kind,folder",
    [("slope_request", "invalid-slope-check-requests"), ("radio_request", "invalid-radio-link-requests")],
)
def test_shared_invalid_engineering_requests_are_rejected_by_schema(kind, folder):
    paths = sorted((SHARED_FIXTURES / folder).glob("*.json"))
    assert paths, f"no fixture in {folder}"
    accepted = [p.name for p in paths if not schema_errors(kind, load_json(p))]
    assert not accepted, f"accepted by the schema: {accepted}"


# --- bench fixtures -----------------------------------------------------------------------


@pytest.mark.parametrize("name", sorted(CASES["valid"]))
def test_bench_valid_scenario_matches_schema(name):
    assert schema_errors("request", scenario("valid", name)) == []


@pytest.mark.parametrize("name", sorted(CASES["invalid"]))
def test_bench_invalid_scenario_schema_verdict(name):
    case = CASES["invalid"][name]
    errors = schema_errors("request", scenario("invalid", name))
    if case["schema_valid"]:
        # Rejected by the implementations, but the schema cannot express the rule.
        assert errors == [], f"expected schema to accept {name} ({case.get('note')})"
    else:
        assert errors, f"schema accepts {name}"


def test_sites_are_labelled_and_sourced():
    for site in load_json(SHARED_FIXTURES / "sites.json")["sites"]:
        assert site["source"].strip(), f"{site['id']} has no source"
        if site["kind"] == "synthetic_test_point":
            assert (
                "not a landing site" in (site["name"] + site["notes"]).lower()
                or "synthetic" in site["name"].lower()
            )


# --- drift between implementations --------------------------------------------------------


def _enum(kind, *path):
    node = schema(kind)
    for key in path:
        node = node[key]
    return set(node["enum"])


def _ts_union(text, anchor):
    m = re.search(anchor + r"\s*[:=]\s*((?:\s*\|?\s*\"[^\"]+\")+)", text)
    assert m, f"union for {anchor!r} not found in types.ts"
    return set(re.findall(r'"([^"]+)"', m.group(1)))


def _rust_enum(text, name):
    m = re.search(r"pub enum " + name + r"\s*\{([^}]*)\}", text)
    assert m, f"enum {name} not found"
    variants = re.findall(r"^\s*([A-Z]\w*)", m.group(1), re.M)
    return {re.sub(r"(?<!^)([A-Z])", r"_\1", v).lower() for v in variants}


@pytest.mark.parametrize(
    "label,schema_values,ts_anchor",
    [
        (
            "terrain_mode",
            lambda: _enum("request", "properties", "terrain_mode"),
            r"type TerrainMode",
        ),
        ("status", lambda: _enum("response", "properties", "status"), r"type ScenarioStatus"),
        (
            "ephemeris_provider",
            lambda: _enum("response", "properties", "model", "properties", "ephemeris_provider"),
            r"ephemeris_provider",
        ),
        (
            "horizon_model",
            lambda: _enum("response", "properties", "model", "properties", "horizon_model"),
            r"horizon_model",
        ),
        (
            "provenance kind",
            lambda: _enum(
                "response", "properties", "data_provenance", "items", "properties", "kind"
            ),
            r"kind",
        ),
        (
            "error code",
            lambda: _enum("error", "properties", "error", "properties", "code"),
            r"code",
        ),
    ],
)
def test_typescript_enums_match_schema(label, schema_values, ts_anchor):
    assert _ts_union(read(TS_TYPES), ts_anchor) == schema_values(), f"{label} drift in types.ts"


@pytest.mark.parametrize(
    "rust_file,enum,schema_values",
    [
        (RUST_SCENARIO, "TerrainMode", lambda: _enum("request", "properties", "terrain_mode")),
        (RUST_SCENARIO, "ScenarioStatus", lambda: _enum("response", "properties", "status")),
        (
            RUST_ERROR,
            "ErrorCode",
            lambda: _enum("error", "properties", "error", "properties", "code"),
        ),
    ],
)
def test_rust_enums_match_schema(rust_file, enum, schema_values):
    assert _rust_enum(read(rust_file), enum) == schema_values()


def test_schema_version_agrees_everywhere():
    expected = schema("response")["properties"]["schema_version"]["const"]
    cpp = re.search(r'SCHEMA_VERSION = "([^"]+)"', read(CPP_MODELS))
    ts = re.search(r'schema_version: "([^"]+)"', read(TS_TYPES))
    assert cpp and cpp.group(1) == expected, "C++ SCHEMA_VERSION differs from the schema"
    assert ts and ts.group(1) == expected, "types.ts schema_version differs from the schema"


def test_max_samples_agrees_between_gateway_and_science():
    rust = re.search(r"MAX_SAMPLES: u64 = ([\d_]+)", read(RUST_SCENARIO))
    cpp = re.search(r"MAX_SAMPLES = ([\d']+)", read(CPP_MODELS))
    assert rust and cpp, "MAX_SAMPLES constant not found"
    assert int(rust.group(1).replace("_", "")) == int(cpp.group(1).replace("'", ""))


def test_max_samples_is_part_of_the_contract():
    text = str(schema("request"))
    if "20000" not in text and "MAX_SAMPLES" not in text:
        contract_gap(
            "MAX_SAMPLES (20 000) is enforced by Rust and C++ but absent from "
            "scenario-request.schema.json: schema-valid requests can get a 422"
        )


def test_response_timestamps_have_a_format_in_the_contract():
    props = schema("response")
    sample_utc = props["properties"]["samples"]["items"]["properties"]["utc"]
    window = props["$defs"]["window"]["properties"]["start_utc"]
    if "pattern" not in sample_utc or "pattern" not in window:
        contract_gap(
            "samples[].utc and windows[].start_utc/end_utc are plain strings in the schema "
            "(no 'Z' pattern, no stated precision); the science service emits millisecond 'Z' times"
        )


# --- endpoints listed in CLAUDE.md without a contract -------------------------------------

ROUTES = {
    "/scenarios/compare": "POST /scenarios/compare (P0: two-scenario comparison)",
    "/scenarios/search": "POST /scenarios/search (after MVP)",
    "/terrain/": "GET /terrain/{site_id} (after terrain availability)",
}


@pytest.mark.parametrize("route", sorted(ROUTES))
def test_proposed_endpoint_has_a_contract(route):
    lib = read(RUST_LIB)
    names = " ".join(p.name for p in SCHEMAS.glob("*.json"))
    stem = route.strip("/").split("/")[-1]
    if stem not in names:
        contract_gap(
            f"{ROUTES[route]} is proposed in CLAUDE.md but has no schema in packages/contracts"
            + (" (route exists in the gateway!)" if route in lib else " and no gateway route")
        )


def test_celestial_state_contract_is_shared():
    if not TS_CELESTIAL.is_file():
        pytest.skip("apps/web no longer defines a celestial contract")
    if not any("celestial" in p.name for p in SCHEMAS.glob("*.json")):
        contract_gap(
            "GET /celestial/state is defined only as a DRAFT TypeScript type "
            "(apps/web/src/api/celestialTypes.ts, schema_version 0.0.1-draft); no JSON Schema, "
            "no backend route"
        )
