#!/usr/bin/env bash
# Start science (:8000), api (:8080) and web (:5173) locally without Docker.
# Prereqs: one-time setup from README.md. Ctrl+C stops all three.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SCIENCE=""
for c in build/selene-science build/selene-science.exe build/Release/selene-science.exe; do  # Unix, MinGW, MSVC
  [ -x "$ROOT/services/science/$c" ] && SCIENCE="$ROOT/services/science/$c" && break
done
[ -n "$SCIENCE" ] || { echo "science service not built: see README.md" >&2; exit 1; }

API="$ROOT/services/api"
SIM="$API/target/sim"
mkdir -p "$SIM"
g++ -O2 -o "$SIM/calc-planete" "$API/simulation/simulate.cpp"
gcc -O2 -o "$SIM/calc-radio" "$API/simulation/simulate-slow.c"
# MinGW writes calc-*.exe; profiles.json lists extension-less names, so add extension-less copies.
for n in calc-planete calc-radio; do
  if [ -f "$SIM/$n.exe" ]; then python -c "import shutil,sys; shutil.copyfile(sys.argv[1]+'.exe', sys.argv[1])" "$SIM/$n"; fi
done

# Raw LOLA DEM for POST /terrain/slope/check, if installed (apps/web/scripts/POLAR_DATA.md).
DEM="$ROOT/apps/web/data-raw/lola_polar/ldem_85s_20m_float.img"
if [ -z "${SELENE_DEM_PATH:-}" ] && [ -f "$DEM" ]; then export SELENE_DEM_PATH="$DEM"; fi

trap 'kill 0' EXIT INT TERM
"$SCIENCE" --host 127.0.0.1 --port 8000 &
(cd "$API" && PROFILES_FILE="$API/config/profiles.json" SCRIPTS_DIR="$SIM" cargo run -q) &
(cd "$ROOT/apps/web" && npm run dev) &
wait
