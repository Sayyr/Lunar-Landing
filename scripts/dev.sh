#!/usr/bin/env bash
# Start science (:8000), api (:8080) and web (:5173) locally without Docker.
# Prereqs: one-time setup from README.md. Ctrl+C stops all three.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

API="$ROOT/services/api"
SIM="$API/target/sim"
mkdir -p "$SIM"
g++ -O2 -o "$SIM/calc-planete" "$API/simulation/simulate.cpp"
gcc -O2 -o "$SIM/calc-radio" "$API/simulation/simulate-slow.c"

trap 'kill 0' EXIT INT TERM
(cd "$API" && PROFILES_FILE="$API/config/profiles.json" SCRIPTS_DIR="$SIM" cargo run -q) &
(cd "$ROOT/apps/web" && npm run dev) &
wait
