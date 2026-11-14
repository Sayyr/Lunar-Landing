#!/usr/bin/env python3
"""Tile a PGDA LOLA 5 m site DEM (GeoTIFF, polar stereographic) for the ground view.

Reuses tile_polar_dem.py (projection, sampling, tile writer) so the site grid is read by the
same PolarDem code as the 20 m product. Input: <Site>_final_adj_5mpp_surf.tif from
https://pgda.gsfc.nasa.gov/products/78 (Barker et al.; MOON_ME DE421 per the product page).

The GeoTIFF gives the grid (ModelPixelScale, ModelTiepoint) and the projection (GeoDoubleParams:
centre latitude, radius). It does not state the projection signs nor the height unit/reference,
so, like the 20 m tiler, this script validates against the already-checked 20 m polar product:
it tries both sign conventions and metre/kilometre units at random points inside the site and
refuses to write tiles unless the best fit is within --max-rms-m (and reports the median offset).

Usage (numpy):
  python tile_site_dem.py SITE.tif REF_LDEM.IMG REF_LDEM.LBL REF_MANIFEST.json OUT_DIR [--levels 2]
Writes OUT_DIR/manifest.json (same schema as the polar product) and L{n}/{row}_{col}.u16.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from split_ldem import read_float_tiff, read_tiff_tags  # noqa: E402
from tile_polar_dem import bilinear, parse_label, project, write_product  # noqa: E402


def geokeys(tags: dict) -> dict[int, float]:
    """GeoKeyDirectory (34735) → {key: value}, values inline or from GeoDoubleParams (34736)."""
    d = tags[34735]
    dbl = tags.get(34736, [])
    out: dict[int, float] = {}
    for k in range(d[3]):
        key, loc, count, val = d[4 + 4 * k : 8 + 4 * k]
        if loc == 0:
            out[key] = val
        elif loc == 34736 and count == 1:
            out[key] = dbl[val]
    return out


def site_label(path: str) -> dict:
    """Grid and projection from the GeoTIFF keys; refuses anything this tiler does not handle."""
    with open(path, "rb") as fh:
        _, tags = read_tiff_tags(fh.read())
    keys = geokeys(tags)
    sx, sy, _ = tags[33550]
    i0, j0, _, x0, y0, _ = tags[33922][:6]
    expect = {
        1025: 1,  # GTRasterTypeGeoKey: RasterPixelIsArea (tiepoint at the pixel's corner)
        3075: 15,  # ProjCoordTransGeoKey: CT_PolarStereographic
        3076: 9001,  # ProjLinearUnitsGeoKey: metre
        3092: 1.0,  # ProjScaleAtNatOriginGeoKey
        3082: 0.0,  # ProjFalseEastingGeoKey
        3083: 0.0,  # ProjFalseNorthingGeoKey
    }
    bad = {k: keys.get(k) for k, v in expect.items() if keys.get(k) != v}
    if bad or i0 or j0 or abs(sx - sy) > 1e-9 or abs(keys.get(2057, 0) - keys.get(2058, -1)) > 1e-3:
        raise SystemExit(f"unsupported GeoTIFF: keys {bad}, tiepoint raster ({i0}, {j0}), scale {sx}/{sy}")
    return {
        "lines": tags[257][0],
        "samples": tags[256][0],
        "scale_m": sx,
        # Pixel-is-area: centre of pixel (row, col) at x = x0 + (col + 0.5)·s, y = y0 − (row + 0.5)·s.
        "line_off": y0 / sx - 0.5,
        "sample_off": -x0 / sx - 0.5,
        "radius_km": keys[2057] / 1000,
        "center_lat": keys[3081],  # ProjNatOriginLatGeoKey
        "center_lon": keys[3095],  # ProjStraightVertPoleLongGeoKey
    }


def validate(site: dict, img: np.ndarray, ref_lab: dict, ref_img: np.ndarray, ref_signs: tuple[int, int]) -> dict:
    """Best (signs, unit) by comparison with the reference polar DEM inside the site."""
    R = site["radius_km"] * 1000
    half = max(site["lines"], site["samples"]) * site["scale_m"] / 2
    # Site centre in projected metres (pixel-centre convention above) → its distance from the pole.
    cx = (site["samples"] / 2 - 0.5 - site["sample_off"]) * site["scale_m"]
    cy = (site["line_off"] - (site["lines"] / 2 - 0.5)) * site["scale_m"]
    rho = math.hypot(cx, cy)
    lo = max(0.0, rho - 1.5 * half)
    hi = rho + 1.5 * half
    to_lat = lambda r: -(90 - math.degrees(2 * math.atan(r / (2 * R))))  # noqa: E731 (south pole)
    rng = np.random.default_rng(2)
    lat = rng.uniform(to_lat(lo), to_lat(hi), 400_000)  # to_lat grows with the distance from the pole
    lon = rng.uniform(-180, 180, 400_000)
    rl, rs = project(ref_lab, lat, lon, *ref_signs)
    ref = bilinear(ref_img, rl, rs) * 1000  # m
    best = None
    for sy in (1, -1):
        for sl in (1, -1):
            line, sample = project(site, lat, lon, sy, sl)
            ok = (line >= 1) & (line <= site["lines"] - 2) & (sample >= 1) & (sample <= site["samples"] - 2)
            if ok.sum() < 1000:
                continue
            v = bilinear(img, line[ok], sample[ok])
            for unit, k in (("m", 1.0), ("km", 1000.0)):
                good = np.isfinite(v)
                d = v[good] * k - ref[ok][good]
                med = float(np.median(d))
                rms = float(np.sqrt(np.mean((d - med) ** 2)))
                print(f"  y={sy:+d} line={sl:+d} unit={unit}: median Δ {med:9.1f} m, rms about median {rms:8.1f} m ({good.sum()} pts)")
                if best is None or rms < best["rms_m"]:
                    best = {"sy": sy, "sl": sl, "unit": unit, "median_offset_m": med, "rms_m": rms, "points": int(good.sum())}
    if best is None:
        raise SystemExit("no sign convention puts the site inside its own grid")
    return best


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("tif")
    ap.add_argument("ref_img")
    ap.add_argument("ref_lbl")
    ap.add_argument("ref_manifest")
    ap.add_argument("out")
    ap.add_argument("--levels", type=int, default=2)
    ap.add_argument("--tile", type=int, default=256)
    ap.add_argument("--max-rms-m", type=float, default=15.0)
    ap.add_argument("--max-offset-m", type=float, default=5.0)
    a = ap.parse_args()

    site = site_label(a.tif)
    W, H, px = read_float_tiff(a.tif)
    img = np.frombuffer(px, dtype=np.float32).reshape(H, W)  # native order (read_float_tiff byteswaps)
    ref_lab = parse_label(a.ref_lbl)
    ref_img = np.memmap(a.ref_img, dtype="<f4", mode="r", shape=(ref_lab["lines"], ref_lab["samples"]))
    rp = json.load(open(a.ref_manifest))["projection"]
    print(f"{os.path.basename(a.tif)}: {W}×{H} px at {site['scale_m']} m")
    fit = validate(site, img, ref_lab, ref_img, (rp["sign_y"], rp["sign_line"]))
    print(f"best: {fit}")
    if fit["rms_m"] > a.max_rms_m or abs(fit["median_offset_m"]) > a.max_offset_m:
        raise SystemExit("validation against the 20 m product failed — not writing tiles")

    # Heights in km on the reference sphere; the (small, validated) median offset to the 20 m
    # product is removed so the two join without a step where the ground view switches products.
    km = img * np.float32(0.001 if fit["unit"] == "m" else 1.0) - np.float32(fit["median_offset_m"] / 1000)
    manifest = {
        "source": os.path.basename(a.tif),
        "frame": "MEAN EARTH/POLAR AXIS OF DE421 (PGDA product page)",
        "units": "km relative to a 1737.4 km sphere (validated against the 20 m product; its median offset removed)",
        "provenance": {
            "product": "LOLA 5 m/pixel south-pole site DEM (High-Resolution LOLA Topography for Lunar South Pole Sites)",
            "producer": "NASA GSFC Planetary Geodesy Data Archive (PGDA), M. K. Barker",
            "url": "https://pgda.gsfc.nasa.gov/products/78",
            "license": "NASA data, public; credit NASA/GSFC PGDA",
            "time_coverage": "LRO LOLA altimetry from 2009 on (cut-off date not stated on the product page)",
        },
        "projection": {
            "type": "polar_stereographic_sphere",
            "center_lat": site["center_lat"],
            "center_lon": site["center_lon"],
            "radius_m": site["radius_km"] * 1000,
            "line_off": site["line_off"],
            "sample_off": site["sample_off"],
            "scale_m": site["scale_m"],
            "sign_y": fit["sy"],
            "sign_line": fit["sl"],
        },
        "validation": {"against": os.path.basename(a.ref_img), **fit},
    }
    write_product(km, a.out, a.levels, a.tile, site["scale_m"], manifest)


if __name__ == "__main__":
    main()
