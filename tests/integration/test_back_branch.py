"""Compatibility probe for the `back/` API (branch origin/back-on-main, port 3000).

That service has its own contract: /api/v1/site, lat 0–90 plus N/S, NDJSON stream. These tests
record where it diverges from packages/contracts. They are BLOCKED unless it is running
(SELENE_BENCH_BACK_URL). They never fail CI with --require-live, because the branch is not on main.
"""

from __future__ import annotations

import json

from bench.contracts import schema_errors
from conftest import scenario

QUERY = {"lat": 89.5, "ns": "S", "lon": 45, "ew": "E", "height": 2}


def _lines(reply):
    return [json.loads(line) for line in reply.text.splitlines() if line.strip()]


def test_back_health(back):
    reply = back.get("/api/v1/health")
    assert reply.status == 200 and reply.json == {"status": "ok"}


def test_back_accepts_the_shared_scenario_request(back):
    reply = back.post("/api/v1/site", scenario("valid", "claude-md-example"))
    assert reply.status == 200, (
        f"back rejects the shared ScenarioRequest with HTTP {reply.status}: {reply.text[:200]}"
    )


def test_back_errors_use_shared_envelope(back):
    reply = back.post("/api/v1/site", {"lat": 91, "ns": "S", "lon": 0, "ew": "E", "height": 2})
    assert reply.status == 422
    assert schema_errors("error", reply.json_or_none()) == [], f"error body {reply.text[:200]!r}"


def test_back_results_are_labelled(back):
    reply = back.post("/api/v1/site", QUERY)
    assert reply.status == 200
    results = [m["data"]["output"] for m in _lines(reply) if m.get("type") == "result"]
    assert results, "no result lines"
    for out in results:
        text = json.dumps(out).lower()
        assert "synthetic" in text or "provenance" in text, (
            f"unlabelled result {json.dumps(out)[:200]}: simulator output must say it is synthetic"
        )


def test_back_takes_a_time_input(back):
    reply = back.post("/api/v1/site", {**QUERY, "start_utc": "2026-11-15T00:00:00Z"})
    assert reply.status == 200, f"back rejects a start time (HTTP {reply.status})"
    received = next(m for m in _lines(reply) if m.get("type") == "received")
    assert "start_utc" in received["data"]["query"], (
        "back silently drops start_utc: Sun/Earth directions depend on time"
    )
