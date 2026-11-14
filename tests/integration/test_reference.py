"""Comparisons against recorded reference values, once real ephemerides are served.

Two sources, kept deliberately separate:

1. **JPL Horizons** (independent reference). The bench does not ship any Horizons values.
   Drop real exports, with the exact query used, into fixtures/reference/horizons/ (format:
   fixtures/reference/README.md). Until then these tests are BLOCKED.
2. **Team SPICE script** (`resultats_validation.csv` at the repo root, read-only). It was produced
   by `test_validation_lunar_mission.py` with spkcpo/azlcpo, CN+S, MOON_ME and a 1737.4 km sphere.
   Agreement with it shows two implementations on the same kernels agree. It is **not** an
   independent validation.
"""

from __future__ import annotations

import csv
import math
from datetime import datetime

import pytest

from bench.contracts import BENCH_FIXTURES, REPO
from conftest import blocked

TEAM_CSV = REPO / "resultats_validation.csv"
HORIZONS_DIR = BENCH_FIXTURES / "reference" / "horizons"
# SCIENTIFIC_REFERENCE.md / docs/validation.md proposal for Sun/Earth az/el.
TOLERANCE_DEG = 0.01


def _az_diff(a, b):
    return abs((a - b + 180.0) % 360.0 - 180.0)


def _team_rows():
    if not TEAM_CSV.is_file():
        return []
    with TEAM_CSV.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f, delimiter=";"))
    out = []
    for r in rows:
        height_m = float(r["altitude_km"]) * 1000
        out.append(
            {
                "id": f"{r['site']}|{r['date_utc']}|{r['astre']}",
                "lat": float(r["latitude_deg"]),
                "lon": float(r["longitude_est_deg"]),
                "height_m": height_m,
                "utc": datetime.strptime(r["date_utc"], "%Y %b %d %H:%M:%S UTC").strftime(
                    "%Y-%m-%dT%H:%M:%SZ"
                ),
                "body": r["astre"].lower(),
                "az": float(r["az_spkcpo_deg"]),
                "el": float(r["el_spkcpo_deg"]),
            }
        )
    return out


TEAM_ROWS = _team_rows()


def _evaluate_one(gateway, lat, lon, height_m, utc):
    sent = {
        "site": {"latitude_deg": lat, "longitude_deg": lon, "observer_height_m": height_m},
        "start_utc": utc,
        "duration_hours": 1 / 60,
        "step_minutes": 1,
        "terrain_mode": "ideal",
    }
    body = gateway.post("/scenarios/evaluate", sent).json
    if body.get("status") != "computed":
        blocked(f"real ephemerides not available yet (status={body.get('status')})")
    return body


@pytest.mark.parametrize("row", TEAM_ROWS or [None], ids=lambda r: r["id"] if r else "no-csv")
def test_agrees_with_team_spice_script(gateway, row):
    if row is None:
        blocked(f"{TEAM_CSV.name} not found at the repo root")
    if row["height_m"] > 1000:
        pytest.skip(
            f"altitude {row['height_m']:.0f} m exceeds the contract max observer_height_m=1000. "
            "The script's altitude is above a 1737.4 km sphere, not above the local surface"
        )
    body = _evaluate_one(gateway, row["lat"], row["lon"], row["height_m"], row["utc"])
    got = body["samples"][0][row["body"]]
    d_az, d_el = _az_diff(got["azimuth_deg"], row["az"]), abs(got["elevation_deg"] - row["el"])
    assert d_el < TOLERANCE_DEG and (d_az < TOLERANCE_DEG or abs(row["lat"]) > 89.9), (
        f"backend az/el {got['azimuth_deg']:.5f}/{got['elevation_deg']:.5f} vs team script "
        f"{row['az']:.5f}/{row['el']:.5f} (Δaz {d_az:.5f}°, Δel {d_el:.5f}°). Check frame "
        "(MOON_ME), aberration correction (CN+S vs LT+S) and reference radius"
    )


def _horizons_files():
    return sorted(HORIZONS_DIR.glob("*.csv")) if HORIZONS_DIR.is_dir() else []


@pytest.mark.parametrize("path", _horizons_files() or [None], ids=lambda p: p.stem if p else "none")
def test_agrees_with_jpl_horizons(gateway, path):
    if path is None:
        blocked(
            "no JPL Horizons reference recorded in tests/integration/fixtures/reference/horizons/ "
            "(see fixtures/reference/README.md; the bench never invents reference values)"
        )
    with path.open(encoding="utf-8", newline="") as f:
        rows = [r for r in csv.DictReader(f) if not r["utc"].startswith("#")]
    assert rows, f"{path.name} has no data rows"
    for r in rows:
        body = _evaluate_one(
            gateway,
            float(r["latitude_deg"]),
            float(r["longitude_deg"]),
            float(r["observer_height_m"]),
            r["utc"],
        )
        got = body["samples"][0][r["body"]]
        assert abs(got["elevation_deg"] - float(r["elevation_deg"])) < TOLERANCE_DEG, r
        assert _az_diff(got["azimuth_deg"], float(r["azimuth_deg"])) < TOLERANCE_DEG, r
        assert not math.isnan(got["azimuth_deg"])
