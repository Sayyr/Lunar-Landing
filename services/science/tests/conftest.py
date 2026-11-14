import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from selene_science.app import app

CONTRACTS = Path(__file__).resolve().parents[3] / "packages" / "contracts"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def schema_validator():
    """Return validator(schema_file_name) -> Draft 2020-12 validator with sibling $refs resolved."""
    schemas = {p.name: load_json(p) for p in (CONTRACTS / "schemas").glob("*.json")}
    registry = Registry().with_resources(
        (s["$id"], Resource.from_contents(s)) for s in schemas.values()
    )

    def make(name: str) -> Draft202012Validator:
        return Draft202012Validator(schemas[name], registry=registry)

    return make


@pytest.fixture(scope="session")
def valid_request():
    return load_json(CONTRACTS / "fixtures" / "scenario-request.valid.json")


@pytest.fixture
def client():
    return TestClient(app)
