"""Load the shared JSON Schemas from packages/contracts (read-only) and validate against them."""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

REPO = Path(__file__).resolve().parents[3]
CONTRACTS = REPO / "packages" / "contracts"
SCHEMAS = CONTRACTS / "schemas"
SHARED_FIXTURES = CONTRACTS / "fixtures"
BENCH = Path(__file__).resolve().parents[1]
BENCH_FIXTURES = BENCH / "fixtures"

SCHEMA_FILES = {
    "request": "scenario-request.schema.json",
    "response": "scenario-response.schema.json",
    "error": "error.schema.json",
    "health": "health.schema.json",
    "sites": "sites-response.schema.json",
    "slope_request": "slope-check-request.schema.json",
    "slope_response": "slope-check-response.schema.json",
    "celestial_request": "celestial-state-request.schema.json",
    "celestial_response": "celestial-state-response.schema.json",
    "radio_request": "radio-link-request.schema.json",
    "radio_response": "radio-link-response.schema.json",
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


@cache
def _registry() -> Registry:
    resources = []
    for path in sorted(SCHEMAS.glob("*.schema.json")):
        schema = load_json(path)
        resource = Resource.from_contents(schema)
        # Schemas $ref each other by file name relative to their $id.
        resources += [(schema["$id"], resource), (path.name, resource)]
    return Registry().with_resources(resources)


@cache
def validator(kind: str) -> Draft202012Validator:
    schema = load_json(SCHEMAS / SCHEMA_FILES[kind])
    return Draft202012Validator(schema, registry=_registry())


def schema_errors(kind: str, instance: Any) -> list[str]:
    """Human-readable schema violations (empty list = valid)."""
    errors = sorted(validator(kind).iter_errors(instance), key=lambda e: list(e.absolute_path))
    return [f"{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message}" for e in errors]


def assert_schema(kind: str, instance: Any) -> None:
    errors = schema_errors(kind, instance)
    assert not errors, f"{SCHEMA_FILES[kind]} violations:\n  " + "\n  ".join(errors[:20])


def schema(kind: str) -> dict:
    return load_json(SCHEMAS / SCHEMA_FILES[kind])
