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

trap 'kill 0' EXIT INT TERM
"$SCIENCE" --host 127.0.0.1 --port 8000 &
(cd "$API" && PROFILES_FILE="$API/config/profiles.json" SCRIPTS_DIR="$SIM" cargo run -q) &
(cd "$ROOT/apps/web" && npm run dev) &
wait
