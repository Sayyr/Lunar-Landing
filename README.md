# SELENE — Lunar Landing Site Navigator

NASA Space Apps Challenge 2026 · challenge *Lunar Landing Site Navigator*.
SELENE is an interactive tool for comparing lunar landing sites and dates. It is built around apparent Sun/Earth directions relative to the local horizon.

> **Status: skeleton (iteration 1).** Real ephemerides are **not implemented yet**: `POST /scenarios/evaluate` returns `status: "not_ready"`.
> A separate, conspicuously labelled **SYNTHETIC** endpoint exists only to develop the UI. Its numbers have no physical meaning.
> Read `CLAUDE.md`, `CONTEXT.md` and `docs/validation.md` before contributing.

```
apps/web (React + TS + Vite + R3F)  --/api-->  services/api (Rust/Axum :8080)  -->  services/science (C++/httplib :8000)
                                                                                      +-> SPICE kernels (data/, not in Git)
```

| Path | What |
|---|---|
| `apps/web` | UI: lunar explorer (LOLA relief, IAU names, site picking), scenario form, timeline, Sun·Earth·Moon dashboard (mock), status badges — see `apps/web/README.md` |
| `services/api` | Gateway: input validation, error envelope, forwarding to science. No astronomy math. |
| `services/science` | C++17: geometry, ephemeris providers (SPICE: stub; synthetic fixture), window extraction |
| `services/sciencepy` | Former Python implementation, **reference only** (not built, tested or deployed) |
| `packages/contracts` | JSON Schemas and fixtures shared by all three (see its README) |
| `data/` | Where kernels/DEMs go; acquisition and provenance instructions. Data is git-ignored. |
| `docs/` | `validation.md` (conventions, open decisions, validation plan), `demo.md` |
| `infra/` | `compose.yaml`, nginx config |

## Prerequisites (versions this was built and tested with)

- C++17 compiler and CMake ≥ 3.20 (tested Apple clang 21, CMake 4.4); network on first configure (fetches nlohmann/json and cpp-httplib, pinned by SHA-256)
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
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j --config Release
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
cd services/science && ./build/selene-science --port 8000                                  # 1
cd services/api && cargo run                                                               # 2
cd apps/web && npm run dev                                                                 # 3
```

Open <http://localhost:5173>. Vite proxies `/api/*` to the gateway (`SELENE_API_URL`, default `http://127.0.0.1:8080`).
Note: Vite binds to `localhost`, which may resolve only to IPv6 `::1` on Windows. If you use curl, call `http://localhost:5173`, not `127.0.0.1`.

Configuration: see `.env.example`. All variables are optional.

## Tests and checks

```bash
cd services/science && cmake --build build -j && ctest --test-dir build --output-on-failure
cd services/api     && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
cd apps/web         && npm run typecheck && npm test && npm run build
```

Science memory-safety checks: `-DSELENE_SANITIZE=ON` builds the tests with AddressSanitizer + UBSan (also run in CI); `-DSELENE_FUZZ=ON` (clang) builds the libFuzzer target `fuzz-handler` (see `services/science/tests/fuzz.cpp`).

Contract tests run inside both backend suites. The Rust suite validates the shared fixtures and the gateway output against `packages/contracts/schemas`; the C++ suite checks that live science output still matches those fixtures.
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
Ephemerides → `services/science/src/ephemeris.cpp` (`SpiceEphemerisProvider`) · Terrain → `data/`, new `terrain/` module ·
Rust API → `services/api` (cache, `/scenarios/compare`) · 3D → `apps/web/src/lunar/` (Moon), `apps/web/src/components/celestial/` (Sun·Earth·Moon) ·
UX/DataViz → `Timeline.tsx`, `ResultPanel.tsx`, comparison view · Integration/QA → CI, compose, `docs/`.
Contract changes go through `packages/contracts` first.

## Rules of the road

No secrets, kernels, DEMs or caches in Git. Never present synthetic or unvalidated numbers as physical results.
Geometric visibility is not a power or communication guarantee. Not NASA-certified; not flight-ready.
