#!/usr/bin/env python3
"""Naked-eye stars from the Yale Bright Star Catalogue, 5th revised edition → src/lib/stars.json.

Source: Hoffleit & Warren (1991), VizieR catalogue V/50, file catalog.gz:
  https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz
  (mirror: https://vizier.cfa.harvard.edu/ftp/cats/V/50/catalog.gz)
Positions: equinox J2000, epoch 2000 (no proper motion applied). Kept: Vmag <= MAG_LIMIT.

Usage: python3 -I scripts/build_stars.py catalog.gz src/lib/stars.json
"""

from __future__ import annotations

import gzip
import json
import sys

MAG_LIMIT = 6.0


def parse(line: str) -> list[float | None] | None:
    if not line[75:90].strip() or not line[102:107].strip():
        return None
    ra = (int(line[75:77]) + int(line[77:79]) / 60 + float(line[79:83]) / 3600) * 15
    dec = int(line[84:86]) + int(line[86:88]) / 60 + int(line[88:90]) / 3600
    if line[83] == "-":
        dec = -dec
    vmag = float(line[102:107])
    bv = float(line[109:114]) if line[109:114].strip() else None
    return [round(ra, 3), round(dec, 3), vmag, bv]


def main(src: str, dest: str) -> None:
    with gzip.open(src, "rt", encoding="ascii") as f:
        stars = [s for s in map(parse, f) if s is not None and s[2] <= MAG_LIMIT]
    stars.sort(key=lambda s: s[2])
    out = {
        "source": "Yale Bright Star Catalogue, 5th revised ed. (Hoffleit & Warren 1991), VizieR V/50",
        "url": "https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz",
        "frame": "equatorial, equinox J2000, epoch 2000",
        "mag_limit": MAG_LIMIT,
        "columns": ["ra_deg", "dec_deg", "vmag", "b_v"],
        "stars": stars,
    }
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"{len(stars)} stars -> {dest}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
