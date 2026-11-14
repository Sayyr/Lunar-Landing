#!/usr/bin/env python3
"""Split a CGI Moon Kit LOLA raster (ldem_*.tif) into latitude bands the web app streams.

The app shows ldem_4 (4 MB) at once, then fills in ldem_16 band by band, so the first view no
longer waits for the 66 MB file.

Input : uncompressed float32 TIFF (as ldem_4/16.tif: one band, km relative to 1737.4 km,
        row 0 = +90°, column 0 = −180°, "area" pixels).
Output: OUT_DIR/manifest.json and OUT_DIR/band_NN.f32 — raw little-endian float32, LOSSLESS
        (same values as the TIFF), rows reordered SOUTH-FIRST, i.e. exactly the layout of the
        app's Heightmap array (row 0 = −90°): band rows [row0, row0 + rows) are copied as is.

Usage: python3 -I split_ldem.py ldem_16.tif OUT_DIR [ROWS_PER_BAND]   (standard library only)
"""

from __future__ import annotations

import hashlib
import json
import os
import struct
import sys
from array import array


def read_float_tiff(path: str) -> tuple[int, int, array]:
    """Minimal reader for uncompressed, single-band float32 strip TIFFs (little or big endian)."""
    with open(path, "rb") as fh:
        raw = fh.read()
    bo = {b"II": "<", b"MM": ">"}[raw[:2]]
    if struct.unpack(bo + "H", raw[2:4])[0] != 42:
        raise SystemExit("not a classic TIFF")
    ifd = struct.unpack(bo + "I", raw[4:8])[0]
    n = struct.unpack(bo + "H", raw[ifd : ifd + 2])[0]
    sizes = {3: 2, 4: 4}
    tags: dict[int, list[int]] = {}
    for i in range(n):
        e = ifd + 2 + 12 * i
        tag, typ, count = struct.unpack(bo + "HHI", raw[e : e + 8])
        if typ not in sizes:
            continue
        size = sizes[typ] * count
        fmt = bo + ("H" if typ == 3 else "I") * count
        data = raw[e + 8 : e + 8 + size] if size <= 4 else raw[struct.unpack(bo + "I", raw[e + 8 : e + 12])[0] :][:size]
        tags[tag] = list(struct.unpack(fmt, data))
    width, height = tags[256][0], tags[257][0]
    if tags.get(258, [0])[0] != 32 or tags.get(339, [1])[0] != 3 or tags.get(259, [1])[0] != 1 or tags.get(277, [1])[0] != 1:
        raise SystemExit("expected an uncompressed single-band float32 TIFF")
    out = array("f")
    for off, cnt in zip(tags[273], tags[279]):
        out.frombytes(raw[off : off + cnt])
    if bo == ">":
        out.byteswap()
    if len(out) != width * height:
        raise SystemExit(f"pixel count mismatch: {len(out)} != {width}×{height}")
    return width, height, out


def main(src: str, out_dir: str, rows_per_band: int) -> None:
    width, height, px = read_float_tiff(src)
    if height % rows_per_band:
        raise SystemExit(f"{height} rows are not a multiple of {rows_per_band}")
    os.makedirs(out_dir, exist_ok=True)
    with open(src, "rb") as fh:
        src_sha = hashlib.sha256(fh.read()).hexdigest()
    bands = []
    for b in range(height // rows_per_band):
        row0 = b * rows_per_band  # south-first row index (app layout)
        band = array("f")
        for r in range(row0, row0 + rows_per_band):
            tiff_row = height - 1 - r  # TIFF row 0 is north
            band.extend(px[tiff_row * width : (tiff_row + 1) * width])
        if sys.byteorder != "little":
            band.byteswap()
        blob = band.tobytes()
        name = f"band_{b:02d}.f32"
        with open(os.path.join(out_dir, name), "wb") as fh:
            fh.write(blob)
        bands.append({"file": name, "row0": row0, "rows": rows_per_band, "bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest()})
    manifest = {
        "source": os.path.basename(src),
        "source_sha256": src_sha,
        "width": width,
        "height": height,
        "dtype": "float32le",
        "units": "km relative to a 1737.4 km sphere",
        "layout": "row-major, row 0 = south (−90°), column 0 = −180°, area pixels; lossless copy of the TIFF values",
        "bands": bands,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    print(f"{len(bands)} bands × {rows_per_band} rows ({bands[0]['bytes'] / 1e6:.1f} MB each) in {out_dir}")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) == 4 else 180)
