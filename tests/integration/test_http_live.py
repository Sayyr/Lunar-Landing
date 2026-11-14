"""Live HTTP tests against the Rust gateway and the C++ science service.

Every test is BLOCKED (not executed) while its service is unreachable. Start the services as
described in README.md, or point SELENE_BENCH_API_URL / SELENE_BENCH_SCIENCE_URL elsewhere.
Scientific expectations (Earth always up at the sub-Earth point, ...) only apply to
status == "computed". Synthetic and not_ready responses are checked for labelling and
consistency only.
"""

from __future__ import annotations

import pytest

from bench import invariants as inv
from bench.contracts import SHARED_FIXTURES, assert_schema, load_json, schema_errors
from conftest import CASES, blocked, contract_gap, scenario

VALID = sorted(CASES["valid"])
INVALID = sorted(CASES["invalid"])


def _maybe_heavy(request, name):
    if CASES["valid"][name].get("heavy") and not request.config.getoption("--include-heavy"):
        pytest.skip("heavy scenario (~20k samples): pass --include-heavy")


def _assert_error_envelope(reply, status=None):
    if status is not None:
        assert reply.status == status, f"HTTP {reply.status}, expected {status}: {reply.text[:300]}"
    body = reply.json_or_none()
    assert body is not None, f"HTTP {reply.status} body is not JSON: {reply.text[:200]!r}"
    assert_schema("error", body)
    return body["error"]


def _assert_good_response(reply, sent):
    assert reply.status == 200, f"HTTP {reply.status}: {reply.text[:300]}"
    body = reply.json
    assert_schema("response", body)
    problems = inv.check_all(body, sent) + inv.check_physical_plausibility(body)
    assert not problems, "\n".join(problems[:15])
    return body


# --- shared behaviour of both services -----------------------------------------------------

ENDPOINTS = {
    "gateway": {"real": "/scenarios/evaluate", "synthetic": "/demo/synthetic/evaluate"},
    "science": {"real": "/evaluate", "synthetic": "/evaluate/synthetic"},
}


@pytest.fixture(params=["gateway", "science"])
def svc(request):
    return request.param, request.getfixturevalue(request.param)


def test_health_matches_contract(svc):
    name, client = svc
    reply = client.get("/health")
    assert reply.status == 200
    body = reply.json
    assert_schema("health", body)
    assert body["service"] == {"gateway": "api", "science": "science"}[name]
    if name == "gateway":
        if body["upstream"] is None:
            assert body["status"] == "degraded" and body["upstream_error"]
        else:
            assert body["upstream"]["service"] == "science"
    else:
        assert "ephemeris" in body, "science /health must report ephemeris readiness"


@pytest.mark.parametrize("name", VALID)
def test_real_route_never_returns_synthetic(request, svc, name):
    _maybe_heavy(request, name)
    service, client = svc
    sent = scenario("valid", name)
    body = _assert_good_response(client.post(ENDPOINTS[service]["real"], sent), sent)
    assert body["status"] in ("computed", "not_ready")
    assert body["synthetic"] is False
    if CASES["valid"][name].get("expect_not_ready"):
        assert body["status"] == "not_ready", "DEM mode must be not_ready until a DEM is installed"


@pytest.mark.parametrize("name", VALID)
def test_synthetic_route_is_labelled_and_consistent(request, svc, name):
    _maybe_heavy(request, name)
    service, client = svc
    sent = scenario("valid", name)
    body = _assert_good_response(client.post(ENDPOINTS[service]["synthetic"], sent), sent)
    if CASES["valid"][name].get("expect_not_ready"):
        assert body["status"] == "not_ready"
    else:
        assert body["status"] == "synthetic" and body["synthetic"] is True
    if CASES["valid"][name].get("polar"):
        assert any("pole" in w.lower() for w in body["warnings"]), "no polar warning"


@pytest.mark.parametrize("name", INVALID)
def test_invalid_request_is_rejected_with_envelope(svc, name):
    service, client = svc
    case = CASES["invalid"][name]
    err = _assert_error_envelope(
        client.post(ENDPOINTS[service]["real"], scenario("invalid", name)), 422
    )
    assert err["code"] == "validation_error"
    assert err["details"], "422 without details"
    fields = [d["field"] for d in err["details"]]
    if case["field"] and not any(f == case["field"] or f.startswith(case["field"]) for f in fields):
        contract_gap(
            f"{service} rejects {name} but names field(s) {fields}, not {case['field']!r} "
            "(error.schema.json does not specify field paths)"
        )


@pytest.mark.parametrize(
    "path", sorted((SHARED_FIXTURES / "invalid-requests").glob("*.json")), ids=lambda p: p.stem
)
def test_shared_invalid_fixture_is_rejected(svc, path):
    service, client = svc
    _assert_error_envelope(client.post(ENDPOINTS[service]["real"], load_json(path)), 422)


@pytest.mark.parametrize(
    "raw",
    [b"", b"{", b"null", b"\xff\xfe"],
    ids=["empty", "truncated", "null", "not-utf8"],
)
def test_malformed_body_is_rejected_with_envelope(svc, raw):
    service, client = svc
    _assert_error_envelope(client.post(ENDPOINTS[service]["real"], raw=raw), 422)


def test_unknown_route_uses_error_envelope(svc):
    """error.schema.json: the envelope is returned 'for any non-2xx response'."""
    _, client = svc
    reply = client.get("/definitely-not-a-route")
    assert reply.status == 404
    _assert_error_envelope(reply)


def test_wrong_method_uses_error_envelope(svc):
    service, client = svc
    reply = client.get(ENDPOINTS[service]["real"])
    assert reply.status in (404, 405)
    _assert_error_envelope(reply)


def test_leap_second_behaviour_is_specified(svc):
    service, client = svc
    reply = client.post(ENDPOINTS[service]["real"], scenario("unspecified", "leap-second"))
    contract_gap(
        f"{service} answers HTTP {reply.status} to start_utc 2016-12-31T23:59:60Z (a real leap "
        "second, accepted by the schema pattern); the contract does not say which is right"
    )


def test_evaluation_is_deterministic(svc):
    service, client = svc
    sent = scenario("valid", "claude-md-example")
    a = client.post(ENDPOINTS[service]["synthetic"], sent).json
    b = client.post(ENDPOINTS[service]["synthetic"], sent).json
    assert a == b


# --- gateway-specific ---------------------------------------------------------------------


def test_sites_match_contract(gateway):
    reply = gateway.get("/sites")
    assert reply.status == 200
    assert_schema("sites", reply.json)
    assert reply.json == load_json(SHARED_FIXTURES / "sites.json")


@pytest.mark.parametrize("route", ["real", "synthetic"])
@pytest.mark.parametrize("name", ["claude-md-example", "step-not-dividing-duration", "dem-terrain"])
def test_gateway_forwards_science_output_unchanged(gateway, science, route, name):
    """The gateway must not alter scientific output (no astronomy in Rust)."""
    sent = scenario("valid", name)
    via_gateway = gateway.post(ENDPOINTS["gateway"][route], sent)
    direct = science.post(ENDPOINTS["science"][route], sent)
    assert via_gateway.status == direct.status == 200
    diffs = list(_diff(via_gateway.json, direct.json))
    if diffs:
        numeric = [d for d in diffs if d[1] is not None]
        worst = max((d[1] for d in numeric), default=0.0)
        kind = (
            f"{len(numeric)} floats re-serialized with a relative error up to {worst:.1e} "
            "(last-digit changes: serde_json parsing without the `float_roundtrip` feature?)"
            if len(numeric) == len(diffs)
            else f"{len(diffs)} fields changed"
        )
        pytest.fail(f"gateway alters science output: {kind}; first at {diffs[0][0]}")


def _diff(a, b, path=""):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in a.keys() | b.keys():
            yield from _diff(a.get(k), b.get(k), f"{path}.{k}")
    elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        for i, (x, y) in enumerate(zip(a, b, strict=True)):
            yield from _diff(x, y, f"{path}[{i}]")
    elif isinstance(a, float) and isinstance(b, float) and not isinstance(a, bool):
        if a != b:
            yield path, abs(a - b) / max(abs(a), abs(b))
    elif a != b:
        yield path, None


def test_gateway_health_embeds_live_science_health(gateway, science):
    upstream = gateway.get("/health").json["upstream"]
    assert upstream == science.get("/health").json


def test_readiness_agrees_with_evaluation(science):
    ready = science.get("/health").json["ephemeris"]["ready"]
    sent = scenario("valid", "claude-md-example")
    status = science.post("/evaluate", sent).json["status"]
    assert status == ("computed" if ready else "not_ready"), (
        f"health ready={ready}, evaluate status={status}"
    )


# --- scientific expectations (computed only) -----------------------------------------------


def _computed(client, name):
    sent = scenario("valid", name)
    reply = client.post("/scenarios/evaluate", sent)
    assert reply.status == 200, reply.text[:300]
    body = reply.json
    if body["status"] != "computed":
        blocked(f"real ephemerides not available yet (status={body['status']}: {body['message']})")
    assert schema_errors("response", body) == []
    return body


def test_earth_never_sets_near_sub_earth_point(gateway):
    body = _computed(gateway, "equator-sub-earth-30d")
    low = min(s["earth"]["elevation_deg"] for s in body["samples"])
    assert low > 0, f"Earth elevation drops to {low:.2f}° at lat 0, lon 0 (libration is only ~±8°)"
    assert len(body["windows"]["earth_visible"]) == 1


def test_earth_never_rises_near_anti_earth_point(gateway):
    body = _computed(gateway, "far-side-equator")
    high = max(s["earth"]["elevation_deg"] for s in body["samples"])
    assert high < 0, f"Earth elevation reaches {high:.2f}° at lat 0, lon 180"
    assert body["windows"]["earth_visible"] == []


@pytest.mark.parametrize("name", ["equator-sub-earth-30d", "far-side-equator"])
def test_sun_rises_and_sets_within_a_synodic_month(gateway, name):
    body = _computed(gateway, name)
    wins = body["windows"]["sun_visible"]
    assert any(not w["clipped_start"] for w in wins), "no sunrise in 30 days at the equator"
    assert any(not w["clipped_end"] for w in wins), "no sunset in 30 days at the equator"


def test_polar_sun_stays_near_horizon(gateway):
    body = _computed(gateway, "claude-md-example")
    worst = max(abs(s["sun"]["elevation_deg"]) for s in body["samples"])
    assert worst <= 0.5 + inv.SUN_DECLINATION_BOUND_DEG, (
        f"|Sun elevation| {worst:.2f}° at lat -89.5°"
    )


def test_exact_pole_is_finite_and_deterministic(gateway):
    body = _computed(gateway, "south-pole-exact")
    again = gateway.post("/scenarios/evaluate", scenario("valid", "south-pole-exact")).json
    assert body["samples"] == again["samples"]
    assert inv.check_directions(body) == []
