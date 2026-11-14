#!/usr/bin/env python3
"""Tile a LOLA polar-stereographic DEM (PDS LDEM_*_FLOAT.IMG + .LBL) for the ground view.

Output (OUT_DIR):
  manifest.json            projection, levels, tile size, encoding, validation result
  L{level}/{row}_{col}.u16 one tile = 8-byte header (float32 LE offset_km, float32 LE step_km)
                           + TILE×TILE uint16 LE; height_km = offset_km + value × step_km,
                           value 65535 = no data. Per-tile adaptive step: quantisation error
                           ≤ step/2 (≈ cm for a 20 m tile), far below the product's accuracy.
Levels: 0 = native (20 m for LDEM_85S_20M), then ×2 coarser (2×2 mean), --levels in all (default 7: up to 1280 m).

Projection (spherical polar stereographic, from the label: CENTER_LATITUDE ±90, A_AXIS_RADIUS,
MAP_SCALE, LINE/SAMPLE_PROJECTION_OFFSET, 0-based pixel centres):
  k = 2R·tan(π/4 + lat/2) (south) or 2R·tan(π/4 − lat/2) (north)
  x = k·sin(lon − lon0),  y = SY·k·cos(lon − lon0)
  sample = SAMPLE_PROJECTION_OFFSET + x / MAP_SCALE,  line = LINE_PROJECTION_OFFSET + SL·y / MAP_SCALE
The label does not spell out the signs SY, SL: --check picks them by comparing with the global
ldem_16 at random points and refuses to write tiles if the best match is poor.

Usage (needs numpy, e.g. the science venv):
  python tile_polar_dem.py LDEM.IMG LDEM.LBL OUT_DIR --check ldem_16.tif [--levels 4] [--tile 256]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from split_ldem import read_float_tiff  # noqa: E402  (stdlib TIFF reader, same folder)

NODATA = 65535


def parse_label(path: str) -> dict:
    text = open(path, encoding="latin-1").read()

    def num(key: str) -> float:
        m = re.search(rf"^\s*{key}\s*=\s*([-+0-9.Ee]+)", text, re.M)
        if not m:
            raise SystemExit(f"label: {key} not found")
        return float(m.group(1))

    def word(key: str) -> str:
        m = re.search(rf'^\s*{key}\s*=\s*"?([A-Z_ /0-9]+)"?', text, re.M)
        return m.group(1).strip() if m else ""

    lab = {
        "lines": int(num("LINES")),
        "samples": int(num("LINE_SAMPLES")),
        "scale_m": num("MAP_SCALE"),
        "line_off": num("LINE_PROJECTION_OFFSET"),
        "sample_off": num("SAMPLE_PROJECTION_OFFSET"),
        "radius_km": num("A_AXIS_RADIUS"),
        "center_lat": num("CENTER_LATITUDE"),
        "center_lon": num("CENTER_LONGITUDE"),
        "offset_km": num("OFFSET"),
        "scaling": num("SCALING_FACTOR"),
        "sample_type": word("SAMPLE_TYPE"),
        "unit": word("UNIT"),
        "frame": word("COORDINATE_SYSTEM_NAME"),
        "projection": word("MAP_PROJECTION_TYPE"),
    }
    if lab["sample_type"] != "PC_REAL" or lab["unit"] != "KILOMETER" or "POLAR STEREOGRAPHIC" not in lab["projection"]:
        raise SystemExit(f"unsupported product: {lab}")
    return lab


def project(lab: dict, lat: np.ndarray, lon: np.ndarray, sy: int, sl: int) -> tuple[np.ndarray, np.ndarray]:
    """lat/lon (deg) → 0-based (line, sample) pixel-centre coordinates."""
    R = lab["radius_km"] * 1000
    south = lab["center_lat"] < 0
    phi = np.radians(lat)
    k = 2 * R * (np.tan(np.pi / 4 + phi / 2) if south else np.tan(np.pi / 4 - phi / 2))
    dl = np.radians(lon - lab["center_lon"])
    x = k * np.sin(dl)
    y = sy * k * np.cos(dl)
    return lab["line_off"] + sl * y / lab["scale_m"], lab["sample_off"] + x / lab["scale_m"]


def bilinear(img: np.ndarray, line: np.ndarray, sample: np.ndarray) -> np.ndarray:
    l0 = np.clip(np.floor(line).astype(int), 0, img.shape[0] - 2)
    s0 = np.clip(np.floor(sample).astype(int), 0, img.shape[1] - 2)
    fl = np.clip(line - l0, 0, 1)
    fs = np.clip(sample - s0, 0, 1)
    a = img[l0, s0] * (1 - fs) + img[l0, s0 + 1] * fs
    b = img[l0 + 1, s0] * (1 - fs) + img[l0 + 1, s0 + 1] * fs
    return a * (1 - fl) + b * fl


def check_against_global(lab: dict, dem: np.ndarray, ldem_path: str) -> dict:
    """Pick the projection signs that best match ldem_16; return the fit statistics."""
    W, H, px = read_float_tiff(ldem_path)
    g = np.frombuffer(px.tobytes(), dtype="<f4").reshape(H, W)  # row 0 = +90°, col 0 = −180°
    rng = np.random.default_rng(1)
    n = 4000
    south = lab["center_lat"] < 0
    edge = 90 - (lab["lines"] / 2 * lab["scale_m"]) / (lab["radius_km"] * 1000) * 180 / math.pi * 0.98
    lat = (-1 if south else 1) * rng.uniform(edge, 89.9, n)
    lon = rng.uniform(-180, 180, n)
    # ldem_16 bilinear at the same points (area pixels).
    gy = (90 - lat) / 180 * H - 0.5
    gx = (lon + 180) / 360 * W - 0.5
    ref = bilinear(g, gy, np.mod(gx, W - 1))
    best = None
    for sy in (1, -1):
        for sl in (1, -1):
            line, sample = project(lab, lat, lon, sy, sl)
            ok = (line >= 0) & (line <= lab["lines"] - 1) & (sample >= 0) & (sample <= lab["samples"] - 1)
            v = bilinear(dem, line[ok], sample[ok]) * lab["scaling"]
            good = np.isfinite(v)
            d = v[good] - ref[ok][good]
            rms = float(np.sqrt(np.mean(d * d)))
            med = float(np.median(np.abs(d)))
            print(f"  signs y={sy:+d} line={sl:+d}: rms {rms * 1000:8.1f} m, median |d| {med * 1000:7.1f} m over {good.sum()} pts")
            if best is None or rms < best["rms_km"]:
                best = {"sy": sy, "sl": sl, "rms_km": rms, "median_abs_km": med, "points": int(good.sum())}
    return best


def downsample(a: np.ndarray) -> np.ndarray:
    h, w = a.shape[0] // 2 * 2, a.shape[1] // 2 * 2
    a = a[:h, :w]
    return np.nanmean(a.reshape(h // 2, 2, w // 2, 2), axis=(1, 3))


def write_tiles(level_img: np.ndarray, out: str, tile: int) -> tuple[int, int, int]:
    rows = math.ceil(level_img.shape[0] / tile)
    cols = math.ceil(level_img.shape[1] / tile)
    os.makedirs(out, exist_ok=True)
    written = 0
    for r in range(rows):
        for c in range(cols):
            block = np.full((tile, tile), np.nan, dtype=np.float32)
            src = level_img[r * tile : (r + 1) * tile, c * tile : (c + 1) * tile]
            block[: src.shape[0], : src.shape[1]] = src
            finite = np.isfinite(block)
            if not finite.any():
                continue
            lo = float(block[finite].min())
            hi = float(block[finite].max())
            step = max((hi - lo) / 65534, 1e-9)
            q = np.full((tile, tile), NODATA, dtype="<u2")
            q[finite] = np.round((block[finite] - lo) / step).astype("<u2")
            with open(os.path.join(out, f"{r}_{c}.u16"), "wb") as fh:
                fh.write(np.array([lo, step], dtype="<f4").tobytes())
                fh.write(q.tobytes())
            written += 1
    return rows, cols, written


ENCODING = "8-byte header float32 LE offset_km, step_km; then uint16 LE; 65535 = no data"


def write_product(km: np.ndarray, out: str, n_levels: int, tile: int, scale_m: float, manifest: dict) -> None:
    """Writes the level pyramid (×2 coarser per level, 2×2 mean) and manifest.json (fields + tile, encoding, levels)."""
    levels = []
    for lv in range(n_levels):
        if lv:
            km = downsample(km)
        rows, cols, n = write_tiles(km, os.path.join(out, f"L{lv}"), tile)
        levels.append({"level": lv, "scale_m": scale_m * 2**lv, "lines": km.shape[0], "samples": km.shape[1], "rows": rows, "cols": cols, "tiles": n})
        print(f"  L{lv}: {km.shape[1]}×{km.shape[0]} px at {scale_m * 2**lv:g} m → {n} tiles")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "manifest.json"), "w") as fh:
        json.dump({**manifest, "tile": tile, "encoding": ENCODING, "levels": levels}, fh, indent=1)
    print(f"manifest → {os.path.join(out, 'manifest.json')}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("img")
    ap.add_argument("lbl")
    ap.add_argument("out")
    ap.add_argument("--check", required=True, help="global ldem_16.tif used to validate the projection")
    ap.add_argument("--levels", type=int, default=7)  # 20 m … 1280 m: prefiltered data for the far terrain
    ap.add_argument("--tile", type=int, default=256)
    ap.add_argument("--max-rms-m", type=float, default=300.0)
    a = ap.parse_args()

    lab = parse_label(a.lbl)
    dem = np.memmap(a.img, dtype="<f4", mode="r", shape=(lab["lines"], lab["samples"]))
    print(f"{os.path.basename(a.img)}: {lab['lines']}×{lab['samples']} px, {lab['scale_m']} m/px, {lab['frame']}")
    fit = check_against_global(lab, dem, a.check)
    print(f"best: {fit}")
    if fit["rms_km"] * 1000 > a.max_rms_m:
        raise SystemExit(f"projection check failed: rms {fit['rms_km'] * 1000:.0f} m > {a.max_rms_m} m — not writing tiles")

    km = np.array(dem, dtype=np.float32)  # float32: ~1 mm at these heights, below the cm quantisation
    km *= lab["scaling"]
    manifest = {
        "source": os.path.basename(a.img),
        "frame": lab["frame"],
        "units": "km relative to a 1737.4 km sphere (label OFFSET)",
        "provenance": {
            "product": "LOLA gridded polar DEM (PDS LRO-L-LOLA-3-RDR, " + os.path.basename(a.img) + ")",
            "producer": "LRO LOLA team, NASA GSFC; PDS Geosciences Node",
            "url": "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/",
            "license": "NASA PDS data, public; credit NASA/GSFC LOLA team",
            "time_coverage": "LRO LOLA altimetry from 2009 on (see the product label)",
        },
        "projection": {
            "type": "polar_stereographic_sphere",
            "center_lat": lab["center_lat"],
            "center_lon": lab["center_lon"],
            "radius_m": lab["radius_km"] * 1000,
            "line_off": lab["line_off"],
            "sample_off": lab["sample_off"],
            "scale_m": lab["scale_m"],
            "sign_y": fit["sy"],
            "sign_line": fit["sl"],
            "pixel_index": "0-based pixel centres at level 0; level n: (index + 0.5) / 2^n − 0.5",
        },
        "validation": {"against": os.path.basename(a.check), **fit},
    }
    write_product(km, a.out, a.levels, a.tile, lab["scale_m"], manifest)


if __name__ == "__main__":
    main()
