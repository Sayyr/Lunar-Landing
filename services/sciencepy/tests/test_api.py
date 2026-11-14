def test_health_reports_spice_not_ready(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["service"] == "science"
    assert body["ephemeris"] == {
        "provider": "spice",
        "ready": False,
        "reason": body["ephemeris"]["reason"],
    }
    assert "not implemented" in body["ephemeris"]["reason"]


def test_evaluate_real_is_not_ready_with_no_numbers(client, valid_request):
    r = client.post("/evaluate", json=valid_request)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "not_ready"
    assert body["synthetic"] is False
    assert body["samples"] == []
    assert body["windows"] == {"sun_visible": [], "earth_visible": []}
    assert body["request"] == valid_request


def test_evaluate_synthetic_is_labelled(client, valid_request):
    r = client.post("/evaluate/synthetic", json=valid_request)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "synthetic"
    assert body["synthetic"] is True
    assert body["model"]["ephemeris_provider"] == "synthetic_fixture"
    assert any("SYNTHETIC" in w for w in body["warnings"])
    assert all(p["kind"] == "synthetic" for p in body["data_provenance"])
    # 72 h at 10 min, inclusive end
    assert len(body["samples"]) == 72 * 6 + 1
    assert body["samples"][0]["utc"] == "2026-11-15T00:00:00.000Z"
    assert body["samples"][-1]["utc"] == "2026-11-18T00:00:00.000Z"
    assert body["windows"]["sun_visible"], "synthetic waveform should produce windows"


def test_polar_site_warns(client, valid_request):
    body = client.post("/evaluate/synthetic", json=valid_request).json()
    assert any("ill-conditioned" in w for w in body["warnings"])


def test_dem_mode_not_ready(client, valid_request):
    body = client.post("/evaluate/synthetic", json={**valid_request, "terrain_mode": "dem"}).json()
    assert body["status"] == "not_ready"
    assert body["model"]["horizon_model"] == "dem_terrain"
    assert body["samples"] == []


def test_validation_error_envelope(client, valid_request):
    bad = {**valid_request, "site": {**valid_request["site"], "latitude_deg": 95}}
    r = client.post("/evaluate", json=bad)
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "validation_error"
    assert err["details"][0]["field"] == "site.latitude_deg"


def test_impossible_date_rejected(client, valid_request):
    r = client.post("/evaluate", json={**valid_request, "start_utc": "2026-02-30T00:00:00Z"})
    assert r.status_code == 422


def test_too_many_samples_rejected(client, valid_request):
    r = client.post("/evaluate", json={**valid_request, "duration_hours": 2160, "step_minutes": 1})
    assert r.status_code == 422
    assert r.json()["error"]["details"][0]["field"] == "step_minutes"
