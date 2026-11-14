#!/usr/bin/env bash
# setup-polar-dem.sh — OPTIONAL high-resolution south-polar relief for the ground view.
#
# Downloads LOLA LDEM_85S_20M (PDS Geosciences Node: 20 m/px, 85°S–90°S, MEAN EARTH/POLAR AXIS
# OF DE421, km relative to 1737.4 km; 920 MB) into data-raw/lola_polar/, then tiles it with
# scripts/tile_polar_dem.py into public/data/polar_s/ (~620 MB: 20/40/80/160 m levels).
# The tiler first checks its projection against ldem_16 and refuses to write tiles if they
# disagree; the result is recorded in public/data/polar_s/manifest.json ("validation").
#
# Then, for a few well-surveyed sites, the PGDA LOLA 5 m DEMs (https://pgda.gsfc.nasa.gov/products/78,
# ~41 MB each; PGDA_SITES="Site01 Site04" by default: connecting ridge, Shackleton rim), tiled by
# scripts/tile_site_dem.py after validation against the 20 m product, listed in sites.json.
#
# Not run by setup-data.sh nor the Docker build (size). Without it, the ground view uses ldem_16.
# Needs Python 3.11+ with numpy: PYTHON=… (default: services/science/.venv/bin/python, then python3).
set -euo pipefail

cd "$(dirname "$0")/.."
HERE="$(pwd)"                          # apps/web
RAW="$HERE/data-raw/lola_polar"
OUT="$HERE/public/data/polar_s"
BASE="https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/float_img"
NAME="ldem_85s_20m_float"
SIZE=920272896                         # Content-Length checked on 2026-11-14

PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
  if [[ -x "$HERE/../../services/science/.venv/bin/python" ]]; then PYTHON="$HERE/../../services/science/.venv/bin/python"; else PYTHON=python3; fi
fi
"$PYTHON" -c "import numpy" 2>/dev/null || { echo "✗ $PYTHON has no numpy (set PYTHON=…)" >&2; exit 1; }

mkdir -p "$RAW"
fetch() { # fetch URL DEST
  if command -v wget >/dev/null; then wget -q --show-progress -O "$2.part" "$1"; else curl -fL --progress-bar -o "$2.part" "$1"; fi
  mv "$2.part" "$2"
}

[[ -f "$RAW/$NAME.lbl" ]] || { echo "↓ $NAME.lbl"; fetch "$BASE/$NAME.lbl" "$RAW/$NAME.lbl"; }
if [[ ! -f "$RAW/$NAME.img" ]]; then
  echo "↓ $NAME.img (920 MB)"
  fetch "$BASE/$NAME.img" "$RAW/$NAME.img"
fi
got="$(stat -f%z "$RAW/$NAME.img" 2>/dev/null || stat -c%s "$RAW/$NAME.img")"
[[ "$got" == "$SIZE" ]] || { echo "✗ $NAME.img: $got bytes, expected $SIZE" >&2; exit 1; }

CHECK="$HERE/data-raw/ldem_16.tif"
[[ -f "$CHECK" ]] || CHECK="$HERE/public/data/ldem_16.tif"
[[ -f "$CHECK" ]] || { echo "✗ ldem_16.tif not found: run scripts/setup-data.sh first (used to validate the projection)" >&2; exit 1; }

if [[ ! -f "$OUT/manifest.json" ]]; then
  echo "⚙ tiling (validates the projection against ldem_16 first)"
  "$PYTHON" "$HERE/scripts/tile_polar_dem.py" "$RAW/$NAME.img" "$RAW/$NAME.lbl" "$OUT" --check "$CHECK"
fi
# PGDA 5 m site DEMs.
PGDA="$HERE/data-raw/pgda"
mkdir -p "$PGDA"
SITES_DONE=()
for S in ${PGDA_SITES:-Site01 Site04}; do
  TIF="$PGDA/${S}_final_adj_5mpp_surf.tif"
  [[ -f "$TIF" ]] || { echo "↓ PGDA $S (5 m)"; fetch "https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/$S/${S}_final_adj_5mpp_surf.tif" "$TIF"; }
  if [[ ! -f "$OUT/sites/$S/manifest.json" ]]; then
    echo "⚙ tiling $S (validated against the 20 m product)"
    "$PYTHON" "$HERE/scripts/tile_site_dem.py" "$TIF" "$RAW/$NAME.img" "$RAW/$NAME.lbl" "$OUT/manifest.json" "$OUT/sites/$S"
  fi
  SITES_DONE+=("\"$S\"")
done
( IFS=,; echo "{\"sites\": [${SITES_DONE[*]}]}" > "$OUT/sites.json" )

( cd "$RAW" && shasum -a 256 "$NAME.img" "$NAME.lbl" > SHA256SUMS )
( cd "$PGDA" && shasum -a 256 ./*.tif > SHA256SUMS 2>/dev/null || true )
echo "Done: $(du -sh "$OUT" | cut -f1) in $OUT"
