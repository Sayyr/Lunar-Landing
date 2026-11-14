# SELENE — Lunar Landing Site Navigator

NASA Space Apps Challenge 2026 · challenge *Lunar Landing Site Navigator*.
SELENE is an interactive tool for comparing lunar landing sites and dates. It is built around apparent Sun/Earth directions relative to the local horizon.

> **Status: skeleton (iteration 1).** Real ephemerides are **not implemented yet**: `POST /scenarios/evaluate` returns `status: "not_ready"`.
> A separate, conspicuously labelled **SYNTHETIC** endpoint exists only to develop the UI. Its numbers have no physical meaning.
> Read `CLAUDE.md`, `CONTEXT.md` and `docs/validation.md` before contributing.

```
apps/web (React + TS + Vite + R3F)  --/api-->  services/api (Rust/Axum :8080)  -->  services/science (Python/FastAPI :8000)
                                                                                      +-> SPICE kernels (data/, not in Git)
```

| Path | What |
|---|---|
| `apps/web` | UI: lunar explorer (LOLA relief, IAU names, site picking), scenario form, timeline, Sun·Earth·Moon dashboard (mock), status badges — see `apps/web/README.md` |
| `services/api` | Gateway: input validation, error envelope, forwarding to science. No astronomy math. |
| `services/science` | Geometry, ephemeris providers (SPICE: stub; synthetic fixture), window extraction |
| `packages/contracts` | JSON Schemas and fixtures shared by all three (see its README) |
| `data/` | Where kernels/DEMs go; acquisition and provenance instructions. Data is git-ignored. |
| `docs/` | `validation.md` (conventions, open decisions, validation plan), `demo.md` |
| `infra/` | `compose.yaml`, nginx config |

## Prerequisites (versions this was built and tested with)

- Python ≥ 3.11 (tested 3.13.0)
- Rust stable (tested 1.94.0)
- Node ≥ 20 with npm (tested Node 24.14.0, npm 11.5.2)
- Optional: Docker with Compose v2+ (Compose file validated with v5.3.1; **image builds not yet tested**)

## Option A — Docker (single command)

```bash
docker compose -f infra/compose.yaml up --build
```
Web: <http://localhost:8081> · API: <http://localhost:8080/health> · Science: <http://localhost:8000/health>

## Option B — local, no Docker

One-time setup:

```bash
# science
cd services/science
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"     # Windows (Linux/macOS: .venv/bin/python)
cd ../..

# api (downloads crates on first build)
cd services/api && cargo build && cd ../..

# web
cd apps/web && npm ci && cd ../..
# optional NASA/IAU data for the 3D views (~90 MB; --light skips ldem_16). Without it the app
# runs with plain spheres and says so. PYTHON=... selects a Python ≥ 3.11 for the IAU names.
apps/web/scripts/setup-data.sh --light
```

Run, either all at once (bash / Git Bash):

```bash
scripts/dev.sh
```

or in three terminals:

```bash
cd services/science && .venv/Scripts/python -m uvicorn selene_science.app:app --port 8000   # 1
cd services/api && cargo run                                                               # 2
cd apps/web && npm run dev                                                                 # 3
```

Open <http://localhost:5173>. Vite proxies `/api/*` to the gateway (`SELENE_API_URL`, default `http://127.0.0.1:8080`).
Note: Vite binds to `localhost`, which may resolve only to IPv6 `::1` on Windows. If you use curl, call `http://localhost:5173`, not `127.0.0.1`.

Configuration: see `.env.example`. All variables are optional.

## Tests and checks

```bash
cd services/science && .venv/Scripts/python -m pytest -q && .venv/Scripts/ruff check . && .venv/Scripts/ruff format --check .
cd services/api     && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd apps/web         && npm run typecheck && npm test && npm run build
```

Contract tests run inside both backend suites. They validate the shared fixtures, and the live handler output, against `packages/contracts/schemas`.
CI (`.github/workflows/ci.yml`) runs the same commands.

## API (gateway, :8080)

| Method & path | Result |
|---|---|
| `GET /health` | gateway status + embedded science health (`ephemeris.ready`, reason) |
| `GET /sites` | preset sites. Currently **synthetic test points only** (not landing sites). |
| `POST /scenarios/evaluate` | real evaluation → currently `status: "not_ready"`, no samples |
| `POST /demo/synthetic/evaluate` | **SYNTHETIC** demo data (`status: "synthetic"`, `synthetic: true`) |

```bash
curl -s -X POST localhost:8080/scenarios/evaluate -H 'content-type: application/json' \
  --data @packages/contracts/fixtures/scenario-request.valid.json
```

Errors always use `{"error": {"code", "message", "details": [{"field", "issue"}]}}`:
422 validation, 503 science unreachable, 502 science response broke the contract.

## Parallel workstreams

Owners are assigned locally (see CONTEXT.md):
Ephemerides → `services/science/.../ephemeris/spice.py` · Terrain → `data/`, new `terrain/` module ·
Rust API → `services/api` (cache, `/scenarios/compare`) · 3D → `apps/web/src/lunar/` (Moon), `apps/web/src/components/celestial/` (Sun·Earth·Moon) ·
UX/DataViz → `Timeline.tsx`, `ResultPanel.tsx`, comparison view · Integration/QA → CI, compose, `docs/`.
Contract changes go through `packages/contracts` first.

## Rules of the road

No secrets, kernels, DEMs or caches in Git. Never present synthetic or unvalidated numbers as physical results.
Geometric visibility is not a power or communication guarantee. Not NASA-certified; not flight-ready.
