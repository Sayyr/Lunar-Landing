#!/usr/bin/env bash
# setup-data.sh — downloads and prepares the NASA / IAU data used by the web app into
# apps/web/public/data/ (git-ignored). Formerly apps/moon-explorer/setup.sh.
#
# Usage: apps/web/scripts/setup-data.sh            # ldem_4 + ldem_16 + 4k colour + names + Earth
#        apps/web/scripts/setup-data.sh --light    # without ldem_16 (66 MB)
#
# Nothing is downloaded when the site runs: only this script, run explicitly, uses the network.
# Files already present are not downloaded again. Without the data the app still runs
# (untextured, undisplaced globes) and says so in the UI.
set -euo pipefail

cd "$(dirname "$0")/.."
HERE="$(pwd)"                 # apps/web
DATA="$HERE/public/data"      # served by Vite and copied into dist/ by `npm run build`
RAW="$HERE/data-raw"          # raw downloads — outside public/, never served or bundled
mkdir -p "$DATA" "$RAW"

SVS_MOON="https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720"   # SVS 4720 CGI Moon Kit
SVS_EARTH="https://svs.gsfc.nasa.gov/vis/a000000/a002900/a002915"  # SVS 2915 Blue Marble
IAU="https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip"

# Python 3.11+ (standard library only). Override with e.g. PYTHON=~/miniconda3/bin/python3.
PYTHON="${PYTHON:-python3}"

LIGHT=0
[[ "${1:-}" == "--light" ]] && LIGHT=1

# Sizes recorded 2026-11-14 (SVS server Content-Length): simple integrity check.
# (function rather than an associative array: macOS bash 3.2 has no `declare -A`)
expected_size() {
  case "$1" in
    lroc_color_poles_4k.tif) echo 13095388 ;;
    ldem_4.tif) echo 4153352 ;;
    ldem_16.tif) echo 66378634 ;;
    bluemarble-2048.png) echo 1511379 ;;
  esac
}

fetch() { # fetch URL DEST
  if command -v wget >/dev/null; then
    wget -q --show-progress -O "$2.part" "$1"
  else
    echo "  (wget not found: using curl)"
    curl -fL --progress-bar -o "$2.part" "$1"
  fi
  mv "$2.part" "$2"
}

filesize() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1"; }

get_svs() { # get_svs BASE_URL NAME DEST
  local base="$1" name="$2" dest="$3"
  if [[ -f "$dest" ]]; then echo "✓ $name already present"; return; fi
  echo "↓ $name"
  fetch "$base/$name" "$dest"
  local want; want="$(expected_size "$name")"
  local got; got="$(filesize "$dest")"
  if [[ -n "$want" && "$got" != "$want" ]]; then
    echo "⚠ $name: $got bytes (expected $want). The file may have changed on the SVS server;"
    echo "  check $base before using it."
  fi
}

# 1. LOLA elevation (float32 TIFF, km relative to 1737.4 km). ldem_4 is served as is; ldem_16 is
#    split into 16 latitude bands (lossless, ~4 MB each) that the app streams after the first view.
get_svs "$SVS_MOON" ldem_4.tif "$DATA/ldem_4.tif"
if [[ $LIGHT == 0 ]]; then
  # Older installs served the whole TIFF from public/: keep it as the raw source instead.
  [[ -f "$DATA/ldem_16.tif" && ! -f "$RAW/ldem_16.tif" ]] && mv "$DATA/ldem_16.tif" "$RAW/ldem_16.tif"
  rm -f "$DATA/ldem_16.tif"
  get_svs "$SVS_MOON" ldem_16.tif "$RAW/ldem_16.tif"
  if [[ ! -f "$DATA/ldem_16/manifest.json" ]]; then
    echo "⚙ splitting ldem_16 into streamable bands"
    "$PYTHON" -I "$HERE/scripts/split_ldem.py" "$RAW/ldem_16.tif" "$DATA/ldem_16"
  fi
fi

# 2. LROC WAC 4k colour → JPEG (also used by the Sun–Earth–Moon dashboard).
get_svs "$SVS_MOON" lroc_color_poles_4k.tif "$RAW/lroc_color_poles_4k.tif"
if [[ ! -f "$DATA/moon_color.jpg" ]]; then
  echo "⚙ converting colour → moon_color.jpg"
  SRC="$RAW/lroc_color_poles_4k.tif"; OUT="$DATA/moon_color.jpg"
  if command -v magick >/dev/null; then
    magick "$SRC" -depth 8 -quality 90 -interlace JPEG "$OUT"
  elif command -v convert >/dev/null; then
    convert "$SRC" -depth 8 -quality 90 -interlace JPEG "$OUT"
  elif command -v gdal_translate >/dev/null; then
    gdal_translate -q -of JPEG -ot Byte -co QUALITY=90 "$SRC" "$OUT"
    rm -f "$OUT.aux.xml"
  elif command -v sips >/dev/null; then   # macOS, no extra dependency
    sips -s format jpeg -s formatOptions 90 "$SRC" --out "$OUT" >/dev/null
  else
    echo "✗ ImageMagick, GDAL or sips is required to convert the colour mosaic." >&2; exit 1
  fi
fi

# 3. IAU names: official shapefile → light JSON.
#    (The USGS site's "CSV" export is generated in the browser, with no direct URL; a hand-exported
#     CSV is also accepted: python3 -I scripts/build_features.py file.csv public/data/features.json)
if [[ ! -f "$DATA/features.json" ]]; then
  echo "↓ IAU gazetteer (Moon)"
  fetch "$IAU" "$RAW/MOON_nomenclature_center_pts.zip"
  # -I: isolated mode, imports nothing from the downloaded-data folder.
  "$PYTHON" -I "$HERE/scripts/build_features.py" "$RAW/MOON_nomenclature_center_pts.zip" "$DATA/features.json"
fi

# 4. Earth texture for the Sun–Earth–Moon dashboard: Blue Marble, equirectangular, lon −180 at left.
get_svs "$SVS_EARTH" bluemarble-2048.png "$DATA/earth_bluemarble_2048.png"

# 5. Checksums (record them in apps/web/README.md for traceability). Not served: see .gitignore,
#    infra/nginx.conf.
echo "⚙ SHA-256 → data-raw/SHA256SUMS"
( cd "$DATA" && shasum -a 256 ./*.tif ./*.jpg ./*.png ./*.json 2>/dev/null > "$RAW/SHA256SUMS" || true )
( cd "$RAW" && shasum -a 256 ./*.tif ./*.zip 2>/dev/null >> "$RAW/SHA256SUMS" || true )

echo
ls -lh "$DATA" | sed 1d
echo
echo "Done. Start the app:  cd apps/web && npm run dev"
