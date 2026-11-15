#!/usr/bin/env bash
# setup-slope-grid.sh — the 4 km disc slope grid of the "South-pole grid" page (#/grid), for local dev.
# Docker builds the same file in apps/web/Dockerfile (stage "grid"); keep the URL and hashes in sync.
#
# 1. Downloads LOLA LDEM_85S_20M (PDS Geosciences Node, 920 MB) into data-raw/lola_polar/ unless it is
#    already there; size and SHA-256 checked (hashes recorded from the PDS download on 2026-11-15).
#    setup-polar-dem.sh uses the same file: either script reuses the other's download.
# 2. Builds services/science slope-grid and writes public/data/polar_s_grid/grid_4km.json (~2.8 MB, ~2 s).
# Explicit, one-time setup: never run by the build or dev.sh.
set -euo pipefail
WEB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$WEB/../.." && pwd)"
RAW="$WEB/data-raw/lola_polar"
OUT="$WEB/public/data/polar_s_grid/grid_4km.json"
NAME="ldem_85s_20m_float"
BASE="https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/float_img"
IMG_SHA256="bbfd0295c7ae0759dd7b2513e1ebd61fd5e3d304e35b3fa2ae9e6840054d9b7a"
LBL_SHA256="7ad5bed3dc8c4e48ace39f10b0f8aa5b8e1eff8bcece89f89ed11297a9ff04ed"
IMG_SIZE=920272896

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

fetch() { # fetch FILE SHA256: keep a verified file, else download, verify, then move into place
  local dest="$RAW/$1" want="$2"
  if [[ -f "$dest" && "$(sha256 "$dest")" == "$want" ]]; then echo "ok      $1"; return; fi
  echo "fetch   $BASE/$1"
  curl -fL --retry 3 --progress-bar -o "$dest.part" "$BASE/$1"
  local got; got="$(sha256 "$dest.part")"
  if [[ "$got" != "$want" ]]; then
    rm -f "$dest.part"
    echo "SHA-256 mismatch for $1: expected $want, got $got" >&2
    exit 1
  fi
  mv "$dest.part" "$dest"
}

mkdir -p "$RAW"
fetch "$NAME.lbl" "$LBL_SHA256"
fetch "$NAME.img" "$IMG_SHA256"
got="$(stat -f%z "$RAW/$NAME.img" 2>/dev/null || stat -c%s "$RAW/$NAME.img")"
[[ "$got" == "$IMG_SIZE" ]] || { echo "$NAME.img: $got bytes, expected $IMG_SIZE" >&2; exit 1; }
( cd "$RAW" && printf '%s  %s\n%s  %s\n' "$IMG_SHA256" "$NAME.img" "$LBL_SHA256" "$NAME.lbl" > SHA256SUMS )

BUILD="$ROOT/services/science/build"
[[ -f "$BUILD/CMakeCache.txt" ]] || cmake -S "$ROOT/services/science" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD" --target slope-grid
mkdir -p "$(dirname "$OUT")"
"$BUILD/slope-grid" "$RAW/$NAME.img" "$RAW/$NAME.lbl" "$OUT" --source-sha256 "$IMG_SHA256"
echo "Done: $OUT"
