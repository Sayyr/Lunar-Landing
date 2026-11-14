"""Compatibility probe for the former `back/` API, now served by the gateway binary.

That route has its own contract: POST /api/v1/calcule, lat 0-90 plus N/S, NDJSON stream of the
outputs of the programs listed in services/api/config/profiles.json. These tests record where it
diverges from packages/contracts (reported as CONTRACT-GAP: the route has no schema there). The
labelling rule of CLAUDE.md is enforced: simulator output must say it is synthetic. BLOCKED unless
the gateway is running (SELENE_BENCH_BACK_URL).
"""

from __future__ import annotations

import json

from bench.contracts import schema_errors
from conftest import contract_gap, scenario

ROUTE = "/api/v1/calcule"
QUERY = {"lat": 89.5, "ns": "S", "lon": 45, "ew": "E", "height": 2}


def _lines(reply):
    return [json.loads(line) for line in reply.text.splitlines() if line.strip()]


def test_back_health(back):
    assert back.get("/api/v1/health").status == 200


def test_back_accepts_the_shared_scenario_request(back):
    reply = back.post(ROUTE, scenario("valid", "claude-md-example"))
    if reply.status != 200:
        contract_gap(
            f"{ROUTE} rejects the shared ScenarioRequest (HTTP {reply.status}): it takes "
            "lat/ns/lon/ew/height and has no schema in packages/contracts"
        )


def test_back_errors_use_shared_envelope(back):
    reply = back.post(ROUTE, {"lat": 91, "ns": "S", "lon": 0, "ew": "E", "height": 2})
    assert reply.status == 422
    if schema_errors("error", reply.json_or_none()):
        contract_gap(f"{ROUTE} errors do not use error.schema.json: {reply.text[:120]!r}")


def test_back_results_are_labelled(back):
    reply = back.post(ROUTE, QUERY)
    assert reply.status == 200
    results = [m["data"]["output"] for m in _lines(reply) if m.get("type") == "result"]
    assert results, "no result lines"
    for out in results:
        text = json.dumps(out).lower()
        assert "synthetic" in text or "provenance" in text, (
            f"unlabelled result {json.dumps(out)[:200]}: simulator output must say it is synthetic"
        )


def test_back_takes_a_time_input(back):
    reply = back.post(ROUTE, {**QUERY, "start_utc": "2026-11-15T00:00:00Z"})
    received = next((m for m in _lines(reply) if m.get("type") == "received"), None)
    if reply.status != 200 or received is None or "start_utc" not in received["data"]["query"]:
        contract_gap(
            f"{ROUTE} takes no time input (HTTP {reply.status}); Sun/Earth directions depend on "
            "time, so its programs cannot return real ones"
        )
