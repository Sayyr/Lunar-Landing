"""Fetch the JPL Horizons az/el reference used by test_reference.py::test_agrees_with_jpl_horizons.

    python3 tests/integration/fixtures/reference/fetch_horizons.py

Queries the public Horizons API (https://ssd.jpl.nasa.gov/api/horizons.api), observer table,
center = user-defined site on the Moon (coord@301), quantity 4 (apparent azimuth/elevation,
airless), for the same 8 sites x 3 epochs as the team's test_validation_lunar_mission.py.
Writes horizons/team_sites.csv: the CSV header line, then '#' comment rows with the exact query
and the frame/model Horizons reports, then the data rows. Values are copied verbatim from
Horizons; nothing is computed here. Standard library only.
"""

from __future__ import annotations

import csv
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://ssd.jpl.nasa.gov/api/horizons.api"
OUT = Path(__file__).resolve().parent / "horizons" / "team_sites.csv"

# (name, planetocentric lat deg, east lon deg): test_validation_lunar_mission.py SITES. The team's
# altitudes (up to 2 km) exceed the contract's observer_height_m <= 1000 m, so every site uses a
# 2 m observer (the CLAUDE.md example height). The 1.5 km case is covered by spice_tests.cpp vs azlcpo.
SITES = [
    ("Reference", -85.0, -30.0),
    ("Pres pole Sud", -89.5, 45.0),
    ("Sud autre cote", -70.0, 120.0),
    ("Hemisphere Sud", -30.0, -160.0),
    ("Equateur 0", 0.0, 0.0),
    ("Equateur Est", 0.0, 90.0),
    ("Hemisphere Nord", 45.0, -135.0),
    ("Pres pole Nord", 89.0, 10.0),
]
HEIGHT_KM = 0.002
EPOCHS = ["2026-11-14T12:00:00Z", "2026-12-01T12:00:00Z", "2027-05-01T00:00:00Z"]
BODIES = {"sun": "10", "earth": "399"}


def query(command: str, lat: float, lon: float, h_km: float) -> tuple[dict[str, str], str]:
    tlist = " ".join("'" + e[:10] + " " + e[11:16] + "'" for e in EPOCHS)
    params = {
        "format": "text",
        "COMMAND": f"'{command}'",
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'",
        "CENTER": "'coord@301'",
        "COORD_TYPE": "'GEODETIC'",  # on the 1737.4 km lunar sphere geodetic = planetocentric
        "SITE_COORD": f"'{lon % 360.0:g},{lat:g},{h_km:g}'",  # E-lon (deg), lat (deg), alt (km)
        "TLIST": tlist,
        "TIME_TYPE": "'UT'",
        "QUANTITIES": "'4'",
        "ANG_FORMAT": "'DEG'",
        "APPARENT": "'AIRLESS'",
        "CSV_FORMAT": "'YES'",
        "EXTRA_PREC": "'YES'",
    }
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "selene-reference-fetch"})
    with urllib.request.urlopen(req, timeout=60) as r:
        text = r.read().decode()
    if "$$SOE" not in text:
        raise RuntimeError(f"Horizons returned no ephemeris for {params['SITE_COORD']}:\n{text[:2000]}")
    meta = {}
    for key in ("API VERSION", "Target body name", "Center pole/equ", "Center radii", "Atmos refraction", "Center geodetic"):
        m = re.search(rf"^{re.escape(key)}\s*:\s*(.+?)\s*$", text, re.M)
        meta[key] = re.sub(r"\s+", " ", m.group(1)) if m else "?"
    body = text.split("$$SOE")[1].split("$$EOE")[0]
    return meta, body


def main() -> None:
    rows, notes = [], {}
    h = HEIGHT_KM
    for name, lat, lon in SITES:
        for body, command in BODIES.items():
            meta, data = query(command, lat, lon, h)
            notes.setdefault(body, meta)
            lines = [ln for ln in data.strip().splitlines() if ln.strip()]
            assert len(lines) == len(EPOCHS), (name, body, lines)
            for epoch, ln in zip(EPOCHS, lines):
                f = [x.strip() for x in ln.split(",")]
                stamp = datetime.strptime(f[0], "%Y-%b-%d %H:%M:%S.%f").replace(tzinfo=timezone.utc)
                assert stamp.strftime("%Y-%m-%dT%H:%M:%SZ") == epoch, (f[0], epoch)
                rows.append([epoch, body, lat, lon, h * 1000.0, f[3], f[4]])

    fetched = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    comments = [
        f"# JPL Horizons API ({API}), fetched {fetched} by fetch_horizons.py in this folder (exact query there).",
        "# Observer table, CENTER='coord@301' COORD_TYPE='GEODETIC' SITE_COORD='E-lon,lat,alt_km', TIME_TYPE='UT',",
        "# QUANTITIES='4' (apparent azimuth/elevation), APPARENT='AIRLESS', EXTRA_PREC='YES'. Targets 10 (Sun), 399 (Earth centre).",
        f"# Horizons API version: {notes['sun']['API VERSION']}. Ephemeris: {notes['sun']['Target body name']}.",
        f"# Center pole/equ: {notes['sun']['Center pole/equ']}; center radii: {notes['sun']['Center radii']}; "
        f"refraction: {notes['sun']['Atmos refraction']}.",
        "# Azimuth clockwise from north (Horizons default); elevation above the ideal geometric horizon of the sphere.",
        "# Sites: lat/lon of test_validation_lunar_mission.py, observer 2 m above the sphere. Horizons models relativistic light",
        "# bending and uses DE441; the backend uses DE440, CN+S, no light bending: differences of a few mdeg are expected.",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["utc", "body", "latitude_deg", "longitude_deg", "observer_height_m", "azimuth_deg", "elevation_deg"])
        for c in comments:
            fh.write(c + "\n")
        w.writerows(rows)
    print(f"wrote {OUT} ({len(rows)} rows)")


if __name__ == "__main__":
    main()
