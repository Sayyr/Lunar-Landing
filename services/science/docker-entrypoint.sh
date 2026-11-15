#!/bin/sh
# Science container entrypoint: derive the South-pole slope grid (web "South-pole grid" page) from the
# mounted raw LOLA DEM when it is missing or older than the DEM, then start the service.
#
# Nothing is downloaded here: without the DEM (SELENE_DEM_PATH) the step is skipped and the page keeps
# its "not installed" message. A failure never blocks the service. Output is written to a temporary
# file and renamed, so nginx never serves a half-written file. Needs ~2 GB RAM for a few seconds.
set -u

DEM="${SELENE_DEM_PATH:-}"
GRID_DIR="${SELENE_GRID_DIR:-/data/grid}"
GRID="$GRID_DIR/grid_4km.json"

if [ -n "$DEM" ] && [ -f "$DEM" ] && [ -d "$GRID_DIR" ] && [ -w "$GRID_DIR" ]; then
  if [ ! -s "$GRID" ] || [ "$DEM" -nt "$GRID" ]; then
    LBL="${DEM%.*}.lbl"
    [ -f "$LBL" ] || LBL="${DEM%.*}.LBL"
    SUMS="$(dirname "$DEM")/SHA256SUMS"
    SHA=""
    [ -f "$SUMS" ] && SHA="$(grep " $(basename "$DEM")\$" "$SUMS" | cut -d' ' -f1)"
    echo "slope grid: generating $GRID from $DEM"
    if slope-grid "$DEM" "$LBL" "$GRID.tmp" ${SHA:+--source-sha256 "$SHA"} && mv "$GRID.tmp" "$GRID"; then
      echo "slope grid: done"
    else
      rm -f "$GRID.tmp"
      echo "slope grid: generation FAILED; the South-pole grid page will report it as not installed" >&2
    fi
  else
    echo "slope grid: $GRID is up to date"
  fi
else
  echo "slope grid: skipped (no DEM at '${DEM:-unset}' or $GRID_DIR not mounted writable)"
fi

exec selene-science --host 0.0.0.0 --port 8000 "$@"
