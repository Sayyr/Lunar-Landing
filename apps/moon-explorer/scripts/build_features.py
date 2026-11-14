#!/usr/bin/env python3
"""Convertit le gazetteer IAU/USGS (Lune) en JSON léger pour le site.

Entrées acceptées (bibliothèque standard uniquement) :
  * MOON_nomenclature_center_pts.zip — shapefile officiel téléchargeable par script
    (https://planetarynames.wr.usgs.gov/GIS_Downloads) ; on lit la table attributaire .dbf ;
  * un CSV exporté à la main depuis https://planetarynames.wr.usgs.gov/SearchResults
    (bouton « CSV » — export généré dans le navigateur, sans URL directe).

Sortie : {"source", "generated_utc", "fields", "types", "features": [[nom, code, diam_km, lat, lon], ...]}
  * lat : planétocentrique, degrés ; lon : est-positive, ramenée dans [-180, 180) ;
  * coordonnées arrondies à 1e-4° (~3 m), diamètre à 0,01 km.
Les formations « Dropped » (abandonnées par l'IAU) sont exclues.

Usage : python3 -I build_features.py ENTREE.zip|ENTREE.csv SORTIE.json
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import struct
import sys
import zipfile


def read_dbf(raw: bytes) -> list[dict[str, str]]:
    """Lecteur dBASE III minimal (champs C/N), suffisant pour la table du gazetteer."""
    n_rec, header_len, rec_len = struct.unpack("<IHH", raw[4:12])
    fields = []
    pos = 32
    while raw[pos] != 0x0D:
        name = raw[pos : pos + 11].split(b"\0", 1)[0].decode("ascii")
        fields.append((name, raw[pos + 16]))
        pos += 32
    rows = []
    for i in range(n_rec):
        rec = raw[header_len + i * rec_len : header_len + (i + 1) * rec_len]
        if rec[:1] == b"*":  # enregistrement supprimé
            continue
        off = 1
        row = {}
        for name, length in fields:
            row[name] = rec[off : off + length].decode("utf-8", "replace").strip()
            off += length
        rows.append(row)
    return rows


def rows_from_zip(path: str) -> list[dict]:
    with zipfile.ZipFile(path) as z:
        dbf = next(n for n in z.namelist() if n.lower().endswith(".dbf"))
        cpg = next((n for n in z.namelist() if n.lower().endswith(".cpg")), None)
        if cpg and z.read(cpg).strip().upper() not in (b"UTF-8", b"UTF8"):
            print(f"attention : encodage DBF {z.read(cpg)!r}, UTF-8 supposé", file=sys.stderr)
        rows = read_dbf(z.read(dbf))
    return [
        {
            "name": r["clean_name"] or r["name"],
            "type": r["type"],
            "code": r["code"],
            "diameter": r["diameter"],
            "lat": r["center_lat"],
            "lon": r["center_lon"],
            "approval": r["approval"],
        }
        for r in rows
    ]


def rows_from_csv(path: str) -> list[dict]:
    with open(path, encoding="utf-8-sig", newline="") as fh:
        text = fh.read()
    reader = csv.DictReader(io.StringIO(text))

    def col(row, *names):
        for n in names:
            for k in row:
                if k and k.strip().lower() == n:
                    return row[k]
        return ""

    out = []
    for r in reader:
        out.append(
            {
                "name": col(r, "clean feature name", "feature name", "name"),
                "type": col(r, "feature type", "type"),
                "code": col(r, "feature type code", "code"),
                "diameter": col(r, "diameter", "diameter (km)"),
                "lat": col(r, "center latitude", "lat"),
                "lon": col(r, "center longitude", "lon"),
                "approval": col(r, "approval status", "approval"),
            }
        )
    return out


def main(src: str, dst: str) -> None:
    rows = rows_from_zip(src) if src.lower().endswith(".zip") else rows_from_csv(src)
    types: dict[str, str] = {}
    features = []
    skipped = 0
    for r in rows:
        if "dropped" in r["approval"].lower():
            skipped += 1
            continue
        try:
            lat = float(r["lat"])
            lon = float(r["lon"])
            diam = float(r["diameter"] or 0)
        except ValueError:
            skipped += 1
            continue
        if not (-90 <= lat <= 90) or not r["name"]:
            skipped += 1
            continue
        lon = ((lon + 180.0) % 360.0) - 180.0  # 0..360 E → [-180, 180)
        code = r["code"] or r["type"][:2].upper()
        types.setdefault(code, r["type"])
        features.append([r["name"], code, round(diam, 2), round(lat, 4), round(lon, 4)])

    features.sort(key=lambda f: -f[2])  # grandes formations d'abord (lisibilité du fichier)
    out = {
        "source": "IAU/USGS Gazetteer of Planetary Nomenclature (Moon), " + src.rsplit("/", 1)[-1],
        "generated_utc": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "conventions": "lat planetocentric deg; lon east-positive deg in [-180,180); diameter km",
        "fields": ["name", "type_code", "diameter_km", "lat_deg", "lon_deg"],
        "types": types,
        "features": features,
    }
    with open(dst, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(features)} formations écrites dans {dst} ({skipped} ignorées)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
