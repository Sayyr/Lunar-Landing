"""Opt-in (--suites): run each service's own test suite and record the outcome in the report.

The bench only invokes the commands documented in README.md; it does not change them.
A missing toolchain makes the suite BLOCKED, never PASSED.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from bench.contracts import REPO
from conftest import blocked


@pytest.fixture(autouse=True)
def _opt_in(request):
    if not request.config.getoption("--suites"):
        pytest.skip("service suites not requested (pass --suites)")


def _run(cmd: list[str], cwd: Path, timeout: int = 900):
    exe = shutil.which(cmd[0])
    if exe is None:
        blocked(f"`{cmd[0]}` not found on PATH")
    proc = subprocess.run([exe, *cmd[1:]], cwd=cwd, capture_output=True, text=True, timeout=timeout)
    tail = "\n".join((proc.stdout + proc.stderr).strip().splitlines()[-25:])
    assert proc.returncode == 0, f"`{' '.join(cmd)}` exited {proc.returncode}\n{tail}"


def test_rust_gateway_suite():
    _run(["cargo", "test", "--quiet"], REPO / "services/api")


def test_web_suite():
    if not (REPO / "apps/web/node_modules").is_dir():
        blocked("apps/web/node_modules missing: run `npm ci` in apps/web")
    _run(["npm", "test", "--silent"], REPO / "apps/web")


def test_web_typecheck():
    if not (REPO / "apps/web/node_modules").is_dir():
        blocked("apps/web/node_modules missing: run `npm ci` in apps/web")
    _run(["npm", "run", "typecheck", "--silent"], REPO / "apps/web")


def test_cpp_science_suite():
    build = Path(os.environ.get("SELENE_BENCH_SCIENCE_BUILD", REPO / "services/science/build"))
    if not (build / "CTestTestfile.cmake").is_file():
        blocked(
            f"no CMake build in {build}: build services/science first (README.md) "
            "or set SELENE_BENCH_SCIENCE_BUILD"
        )
    _run(["ctest", "--test-dir", str(build), "--output-on-failure"], REPO / "services/science")
