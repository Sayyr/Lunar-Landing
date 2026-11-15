#!/usr/bin/env bash
# Downloads the LOLA DEMs the science service needs to check landing slopes OUTSIDE the south pole
# (the 20 m south-polar LDEM_85S_20M is set up separately, see apps/web/scripts/POLAR_DATA.md):
#
#   sldem2015/  SLDEM2015 at 512 px/deg (~59 m), 60S-60N, 32 tiles x 1.4 GB   (~45 GB)
#   polar/      LDEM_60S_60M + LDEM_60N_60M, 60-90 deg, 60 m, 2 x 3.9 GB        (~7.7 GB)
#
# Source: NASA PDS Geosciences Node, LRO LOLA RDR bundle (public). Nothing is downloaded unless this
# script is run. Re-runs resume / skip finished files. Each image is checked against the exact size
# its PDS3 label declares (LINES x RECORD_BYTES); PDS publishes no checksum for these files, so the
# SHA-256 written to SHA256SUMS is computed locally after download (the service reports it as such).
#
# Usage: scripts/setup-slope-dem.sh [--dir DIR] [--only sldem|polar] [--tile 30s_00s_045_090 ...]
#   --dir   target directory (default: data/dem)
#   --only  download one of the two sets
#   --tile  SLDEM tiles only, by suffix (repeatable), e.g. the one around a site to try it out
# Then run the science service with:
#   SELENE_SLDEM_DIR=DIR/sldem2015
#   SELENE_SLOPE_DEM_PATHS=DIR/polar/ldem_60s_60m_float.img:DIR/polar/ldem_60n_60m_float.img
# (infra/compose.yaml mounts data/dem and sets both.)
set -euo pipefail

BASE=https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data
DIR=data/dem
ONLY=""
TILES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --tile) TILES+=("$2"); shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
label_bytes() {  # expected image size from the PDS3 label
  local lines rb
  lines=$(grep -E '^[[:space:]]*LINES[[:space:]]*=' "$1" | head -1 | tr -dc '0-9')
  rb=$(grep -E '^[[:space:]]*RECORD_BYTES[[:space:]]*=' "$1" | head -1 | tr -dc '0-9')
  echo $((lines * rb))
}
size_of() { stat -f %z "$1" 2>/dev/null || stat -c %s "$1"; }

# fetch URL_DIR STEM DEST_DIR: .lbl, then the .img (resumed), size-checked, SHA256SUMS updated.
fetch() {
  local url="$1" stem="$2" dest="$3"
  mkdir -p "$dest"
  [[ -s "$dest/$stem.lbl" ]] || curl -fsSL --retry 3 -o "$dest/$stem.lbl" "$url/$stem.lbl"
  local want; want=$(label_bytes "$dest/$stem.lbl")
  if [[ -f "$dest/$stem.img" && $(size_of "$dest/$stem.img") == "$want" ]]; then
    echo "ok    $stem.img ($want bytes, already there)"
  else
    echo "get   $stem.img ($((want / 1000000)) MB)"
    curl -fSL --retry 5 -C - -o "$dest/$stem.img" "$url/$stem.img"
    local got; got=$(size_of "$dest/$stem.img")
    if [[ "$got" != "$want" ]]; then
      echo "size mismatch for $stem.img: $got bytes, label says $want; removed" >&2
      rm -f "$dest/$stem.img"
      exit 1
    fi
  fi
  if ! grep -q "  $stem.img\$" "$dest/SHA256SUMS" 2>/dev/null; then
    echo "$(sha256 "$dest/$stem.img")  $stem.img" >> "$dest/SHA256SUMS"
  fi
}

if [[ -z "$ONLY" || "$ONLY" == sldem ]]; then
  if [[ ${#TILES[@]} -eq 0 ]]; then
    for band in 30n_60n 00n_30n 30s_00s 60s_30s; do
      for w in 000 045 090 135 180 225 270 315; do
        TILES+=("${band}_${w}_$(printf %03d $((10#$w + 45)))")
      done
    done
  fi
  for t in "${TILES[@]}"; do fetch "$BASE/sldem2015/tiles/float_img" "sldem2015_512_${t}_float" "$DIR/sldem2015"; done
fi
if [[ -z "$ONLY" || "$ONLY" == polar ]]; then
  for p in ldem_60s_60m ldem_60n_60m; do fetch "$BASE/lola_gdr/polar/float_img" "${p}_float" "$DIR/polar"; done
fi
echo "done: $DIR"
