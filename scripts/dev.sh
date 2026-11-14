#!/usr/bin/env bash
# Start science (:8000), api (:8080) and web (:5173) locally without Docker.
# Prereqs: one-time setup from README.md. Ctrl+C stops all three.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PY="$ROOT/services/science/.venv/bin/python"
[ -x "$PY" ] || PY="$ROOT/services/science/.venv/Scripts/python"   # Windows venv layout

trap 'kill 0' EXIT INT TERM
(cd "$ROOT/services/science" && "$PY" -m uvicorn selene_science.app:app --host 127.0.0.1 --port 8000) &
(cd "$ROOT/services/api" && cargo run -q) &
(cd "$ROOT/apps/web" && npm run dev) &
wait
