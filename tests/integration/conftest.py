"""Bench configuration: live-service clients, fixture loading and the outcome report.

Outcome vocabulary (also used in reports/integration-report.md):
  PASSED        executed, every assertion held
  FAILED        executed, an assertion failed (or the test errored)
  BLOCKED       not executed: a prerequisite is missing (service down, no kernels, no refs)
  CONTRACT-GAP  not executed: the shared contract does not define the expected behaviour
  SKIPPED       not executed for another stated reason (e.g. opt-in suite not requested)
A test that did not execute is never counted as passed.
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
from datetime import UTC, datetime

import pytest

from bench.contracts import BENCH, BENCH_FIXTURES, REPO, load_json
from bench.http import Client

REPORTS = BENCH / "reports"

SERVICES = {
    # name: (env var, default URL, health path)
    # The gateway nests every route under /api/v1 (services/api/src/routes.rs).
    "gateway": ("SELENE_BENCH_API_URL", "http://127.0.0.1:8080/api/v1", "/health"),
    "science": ("SELENE_BENCH_SCIENCE_URL", "http://127.0.0.1:8000", "/health"),
    # The former `back/` API now lives in the gateway binary (POST /api/v1/calcule).
    "back": ("SELENE_BENCH_BACK_URL", "http://127.0.0.1:8080", "/api/v1/health"),
}


def pytest_addoption(parser):
    g = parser.getgroup("selene")
    g.addoption("--suites", action="store_true", help="also run each service's own test suite")
    g.addoption(
        "--require-live",
        action="store_true",
        help="turn BLOCKED live tests (service unreachable) into failures, for CI",
    )
    g.addoption("--include-heavy", action="store_true", help="run heavy scenarios (~20k samples)")


# --- fixtures -----------------------------------------------------------------------------

CASES = load_json(BENCH_FIXTURES / "scenarios" / "cases.json")


def scenario(kind: str, name: str):
    return load_json(BENCH_FIXTURES / "scenarios" / kind / f"{name}.json")


def blocked(reason: str):
    pytest.skip(f"BLOCKED: {reason}")


def contract_gap(reason: str):
    pytest.skip(f"CONTRACT-GAP: {reason}")


_reachability: dict[str, tuple[bool, str]] = {}


def _service(request, name: str) -> Client:
    env, default, health = SERVICES[name]
    client = Client(os.environ.get(env, default))
    if name not in _reachability:
        _reachability[name] = client.reachable(health)
    ok, detail = _reachability[name]
    if not ok:
        msg = f"{name} service not running: {detail} (set {env} to point elsewhere)"
        if request.config.getoption("--require-live") and name != "back":
            pytest.fail(msg)
        blocked(msg)
    return client


@pytest.fixture
def gateway(request) -> Client:
    return _service(request, "gateway")


@pytest.fixture
def science(request) -> Client:
    return _service(request, "science")


@pytest.fixture
def back(request) -> Client:
    return _service(request, "back")


# --- report -------------------------------------------------------------------------------

_results: list[dict] = []


def _classify(report) -> tuple[str, str]:
    if report.passed:
        return "PASSED", ""
    if report.failed:
        msg = (
            str(report.longrepr.reprcrash.message) if hasattr(report.longrepr, "reprcrash") else ""
        )
        return "FAILED", msg.splitlines()[0] if msg else "see pytest output"
    reason = report.longrepr[2] if isinstance(report.longrepr, tuple) else str(report.longrepr)
    reason = reason.removeprefix("Skipped: ")
    for tag in ("BLOCKED", "CONTRACT-GAP"):
        if reason.startswith(tag + ":"):
            return tag, reason[len(tag) + 1 :].strip()
    return "SKIPPED", reason


def pytest_runtest_logreport(report):
    if report.when == "call" or (report.when == "setup" and not report.passed):
        outcome, detail = _classify(report)
        if report.when == "setup" and outcome == "FAILED":
            outcome, detail = "FAILED", f"setup error: {detail}"
        _results.append({"test": report.nodeid, "outcome": outcome, "detail": detail})


def _git(*args: str) -> str:
    try:
        return subprocess.run(
            ["git", *args], cwd=REPO, capture_output=True, text=True, timeout=10
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def pytest_sessionfinish(session, exitstatus):
    if not _results or hasattr(session.config, "workerinput"):
        return
    REPORTS.mkdir(exist_ok=True)
    order = ["FAILED", "BLOCKED", "CONTRACT-GAP", "SKIPPED", "PASSED"]
    counts = {k: sum(r["outcome"] == k for r in _results) for k in order}
    meta = {
        "generated_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "git_branch": _git("rev-parse", "--abbrev-ref", "HEAD"),
        "git_commit": _git("rev-parse", "--short", "HEAD"),
        "git_dirty": bool(_git("status", "--porcelain")),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "services": {
            name: {
                "url": os.environ.get(env, default),
                "probe": _reachability.get(name, (None, "not probed"))[1],
            }
            for name, (env, default, _) in SERVICES.items()
        },
        "counts": counts,
    }
    (REPORTS / "integration-report.json").write_text(
        json.dumps({"meta": meta, "results": _results}, indent=2), encoding="utf-8"
    )

    lines = [
        "# SELENE integration bench report",
        "",
        f"Generated {meta['generated_utc']} on `{meta['git_branch']}` @ `{meta['git_commit']}`"
        + (" (uncommitted changes)" if meta["git_dirty"] else ""),
        "",
        "| Outcome | Count |",
        "|---|---|",
        *[f"| {k} | {v} |" for k, v in counts.items()],
        "",
        "BLOCKED, CONTRACT-GAP and SKIPPED tests were **not executed** and are not passes.",
        "",
        "## Services probed",
        "",
        *[f"- **{n}** `{s['url']}`: {s['probe']}" for n, s in meta["services"].items()],
        "",
    ]
    for outcome in order:
        rows = [r for r in _results if r["outcome"] == outcome]
        if not rows:
            continue
        lines += [f"## {outcome} ({len(rows)})", ""]
        if outcome == "PASSED":
            lines += [f"- `{r['test']}`" for r in rows]
        else:
            lines += [f"- `{r['test']}`: {r['detail'].replace('|', '/')}" for r in rows]
        lines.append("")
    (REPORTS / "integration-report.md").write_text("\n".join(lines), encoding="utf-8")


def pytest_terminal_summary(terminalreporter):
    if not _results:
        return
    order = ["PASSED", "FAILED", "BLOCKED", "CONTRACT-GAP", "SKIPPED"]
    counts = ", ".join(f"{k} {sum(r['outcome'] == k for r in _results)}" for k in order)
    terminalreporter.write_sep("=", "SELENE bench")
    terminalreporter.write_line(counts)
    terminalreporter.write_line(f"report: {REPORTS / 'integration-report.md'}")
