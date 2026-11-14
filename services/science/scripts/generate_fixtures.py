"""Regenerate packages/contracts/fixtures/scenario-response.*.json from the service code.

Run from services/science:  python scripts/generate_fixtures.py
The synthetic fixture uses a coarse 6 h step to stay small; it is SYNTHETIC data.
"""

import json
from pathlib import Path

from fastapi.testclient import TestClient

from selene_science.app import app

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "fixtures"


def write(name: str, data: dict) -> None:
    (FIXTURES / name).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURES / name}")


def main() -> None:
    client = TestClient(app)
    request = json.loads((FIXTURES / "scenario-request.valid.json").read_text(encoding="utf-8"))
    write("scenario-response.not-ready.json", client.post("/evaluate", json=request).json())
    small = {**request, "duration_hours": 48, "step_minutes": 360}
    write("scenario-response.synthetic.json", client.post("/evaluate/synthetic", json=small).json())


if __name__ == "__main__":
    main()
