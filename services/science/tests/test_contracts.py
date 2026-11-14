"""Contract tests: shared fixtures and live service output vs packages/contracts schemas."""

import pytest
from conftest import CONTRACTS, load_json

from selene_science.models import ScenarioRequest

INVALID = sorted((CONTRACTS / "fixtures" / "invalid-requests").glob("*.json"))


def test_valid_request_fixture(schema_validator, valid_request):
    schema_validator("scenario-request.schema.json").validate(valid_request)
    ScenarioRequest.model_validate(valid_request)


@pytest.mark.parametrize("path", INVALID, ids=[p.stem for p in INVALID])
def test_invalid_request_fixtures_rejected_by_schema_and_model(schema_validator, path):
    data = load_json(path)
    assert not schema_validator("scenario-request.schema.json").is_valid(data)
    with pytest.raises(ValueError):
        ScenarioRequest.model_validate(data)


@pytest.mark.parametrize(
    "name",
    [
        "scenario-response.not-ready.json",
        "scenario-response.synthetic.json",
    ],
)
def test_response_fixtures(schema_validator, name):
    schema_validator("scenario-response.schema.json").validate(
        load_json(CONTRACTS / "fixtures" / name)
    )


def test_other_fixtures(schema_validator):
    schema_validator("error.schema.json").validate(
        load_json(CONTRACTS / "fixtures" / "error.validation.json")
    )
    schema_validator("sites-response.schema.json").validate(
        load_json(CONTRACTS / "fixtures" / "sites.json")
    )


@pytest.mark.parametrize("path", ["/evaluate", "/evaluate/synthetic"])
def test_live_responses_match_schema(client, schema_validator, valid_request, path):
    schema_validator("scenario-response.schema.json").validate(
        client.post(path, json=valid_request).json()
    )


def test_live_error_and_health_match_schema(client, schema_validator, valid_request):
    r = client.post("/evaluate", json={**valid_request, "terrain_mode": "lava"})
    schema_validator("error.schema.json").validate(r.json())
    schema_validator("health.schema.json").validate(client.get("/health").json())
