"""Single entry point for the SELENE integration bench.

    python tests/integration/run.py [--suites] [--require-live] [--include-heavy] [pytest args...]

Writes tests/integration/reports/integration-report.{md,json}. Exit code is pytest's:
non-zero if any test FAILED. BLOCKED tests do not fail the run unless --require-live.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> int:
    missing = []
    for mod in ("pytest", "jsonschema", "referencing"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        print(f"missing Python packages: {', '.join(missing)}", file=sys.stderr)
        print(
            f"install with: {sys.executable} -m pip install -r {HERE / 'requirements.txt'}",
            file=sys.stderr,
        )
        return 2
    import pytest

    os.chdir(HERE)
    return pytest.main(["-c", str(HERE / "pytest.ini"), "--rootdir", str(HERE), *sys.argv[1:]])


if __name__ == "__main__":
    sys.exit(main())
