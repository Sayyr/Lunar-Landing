#!/usr/bin/env python3
"""Soft-landing sites on the Moon from the LROC "Anthropogenic Objects" table → src/lunar/landingSites.json.

Source (NASA PDS, LROC RDR volume LROLRC_2001, EXTRAS/SHAPEFILE/ANTHROPOGENIC_OBJECTS):
  https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/EXTRAS/SHAPEFILE/ANTHROPOGENIC_OBJECTS/ANTHROPOGENIC_OBJECTS_180.ZIP
Coordinates measured on LROC NAC images (+ laser ranging for the retroreflectors), Wagner et al. (2017),
Icarus 283, 92-103, doi:10.1016/j.icarus.2016.05.011, kept up to date by the LROC team (see the README).
Only soft landings are kept (landers and Apollo LM descent stages); impacts, rovers and ALSEP
instruments are left out. Spacecraft not yet located in NAC images are absent from the source
(e.g. Luna 9, Luna 13), so they are absent here too — nothing is added by hand.

Latitude planetocentric, longitude east-positive in [-180, 180), degrees (the shapefile's GCS_Moon_2000
sphere, R = 1737.4 km; LROC coordinates are in the Mean Earth / Polar Axis frame).

Usage: python3 -I scripts/build_landing_sites.py ANTHROPOGENIC_OBJECTS_180.ZIP src/lunar/landingSites.json
"""

from __future__ import annotations

import json
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_features import read_dbf  # noqa: E402  (stdlib dBASE reader, same folder)

URL = "https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/EXTRAS/SHAPEFILE/ANTHROPOGENIC_OBJECTS/ANTHROPOGENIC_OBJECTS_180.ZIP"


def is_soft_landing(obj: str) -> bool:
    return obj == "Lander" or obj.startswith("Descent stage of Lunar Module") or obj.endswith(" lander")


def main() -> None:
    src, out = sys.argv[1:3]
    with zipfile.ZipFile(src) as z:
        rows = read_dbf(z.read(next(n for n in z.namelist() if n.upper().endswith(".DBF"))))
        readme = next((z.read(n).decode("latin-1") for n in z.namelist() if n.upper().endswith("README.TXT")), "")
    updated = next((l.split(":", 1)[1].strip() for l in readme.splitlines() if l.startswith("Last updated")), None)
    sites = []
    for r in rows:
        if not is_soft_landing(r["OBJECT"]):
            continue
        d = r["DATE"]
        sites.append({
            "id": r["OBJECT_ID"],
            "mission": r["MISSION"],
            "vehicle": r["VEHCL_NAME"] or None,
            "crewed": r["MISSION"].startswith("Apollo"),
            "lat": round(float(r["LATITUDE"]), 5),  # 1e-5° ≈ 0.3 m, below the stated uncertainties
            "lon": round(float(r["LONGITUDE"]), 5),
            "uncertainty_m": float(r["UNCERTAIN"]),
            "date_utc": f"{d[:4]}-{d[4:6]}-{d[6:8]}",
            "coord_source": r["COORD_SRC"],
        })
    sites.sort(key=lambda s: s["date_utc"])
    if not sites:
        raise SystemExit("no landers found: has the table schema changed?")
    doc = {
        "source": "LROC Anthropogenic Objects (ANTHROPOGENIC_OBJECTS_180), NASA PDS LRO-L-LROC-5-RDR-V1.0",
        "url": URL,
        "citation": "Wagner, R. V., et al. (2017). Coordinates of anthropogenic features on the Moon. Icarus, 283, 92-103. doi:10.1016/j.icarus.2016.05.011",
        "source_updated": updated,
        "frame": "planetocentric latitude, east-positive longitude [-180, 180), degrees; Mean Earth / Polar Axis (LROC)",
        "selection": "soft landings only (landers, Apollo LM descent stages); spacecraft not yet located in LROC NAC images are absent",
        "license": "NASA PDS data, public; credit NASA/GSFC/Arizona State University (LROC)",
        "sites": sites,
    }
    with open(out, "w") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    print(f"{len(sites)} landing sites → {out}")


if __name__ == "__main__":
    main()
