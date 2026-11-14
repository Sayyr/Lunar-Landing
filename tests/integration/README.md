# SELENE integration bench

An independent black-box bench. It checks the shared contracts (`packages/contracts`), the data
flow web contract → Rust gateway → C++ science, and the scientific consistency of responses.
It **reads** other modules (schemas, fixtures, enum literals, constants) and calls them over HTTP.
It never imports or modifies them, and it contains **no ephemeris or geometry engine**.

## Run

```bash
python -m pip install -r tests/integration/requirements.txt     # once (pytest, jsonschema, referencing)
python tests/integration/run.py                                  # everything that can run now
```

Options (extra arguments go to pytest):

| Option | Effect |
|---|---|
| `--suites` | also runs `cargo test`, `npm test`, `npm run typecheck`, `ctest` and records them in the report |
| `--include-heavy` | runs the 19 996-sample scenario |
| `--require-live` | gateway/science unreachable → FAILED instead of BLOCKED (for CI once services are up) |
| `-k gateway` | any pytest selection |

| Environment variable | Default |
|---|---|
| `SELENE_BENCH_API_URL` | `http://127.0.0.1:8080` (Rust gateway) |
| `SELENE_BENCH_SCIENCE_URL` | `http://127.0.0.1:8000` (C++ science) |
| `SELENE_BENCH_BACK_URL` | `http://127.0.0.1:3000` (`back/` API, branch `back-on-main`) |
| `SELENE_BENCH_SCIENCE_BUILD` | `services/science/build` (for `--suites` ctest) |

Start the services as in the root README (`scripts/dev.sh`, or the three terminals), then run.

## Report

Each run writes `tests/integration/reports/integration-report.md` and `.json` (git-ignored).

| Outcome | Meaning |
|---|---|
| PASSED | executed, every assertion held |
| FAILED | executed, an assertion failed |
| BLOCKED | **not executed**: a prerequisite is missing (service down, no real ephemerides, no reference data) |
| CONTRACT-GAP | **not executed**: the shared contract does not define the behaviour; reported, not imposed |
| SKIPPED | not executed for another stated reason (opt-in option, out-of-contract reference row) |

Only PASSED counts as a pass.

## Contents

| File | What it checks |
|---|---|
| `test_contracts.py` | schemas are valid 2020-12; shared + bench fixtures vs schemas; enum/version/`MAX_SAMPLES` drift between schema, `types.ts`, Rust and C++; endpoints proposed in CLAUDE.md without a contract |
| `test_response_invariants.py` | the checks below on the shared response fixtures, and **mutation tests** proving each check detects an injected defect |
| `test_http_live.py` | gateway and science over HTTP: health, sites, valid/invalid/malformed requests, error envelope, labelling, time grid, windows vs samples, determinism, gateway passthrough, health/evaluate consistency, physical expectations once `status == computed` |
| `test_reference.py` | az/el vs JPL Horizons exports (none shipped, so BLOCKED) and vs the team's SPICE script CSV (cross-implementation, not a reference) |
| `test_back_branch.py` | where the `back/` API diverges from `packages/contracts` |
| `test_service_suites.py` | opt-in wrapper around each service's own suite |
| `bench/invariants.py` | labelling, time grid (docs/validation.md rule), az/el ranges, windows = above-horizon runs of the samples, plausibility bounds |
| `fixtures/scenarios/` | 17 valid, 26 invalid and 1 unspecified request; metadata in `cases.json`. All sites are **synthetic test points, not landing sites** |
| `fixtures/reference/README.md` | how to add Horizons references; basis of the plausibility bounds |

### Mocks vs real results

- Synthetic responses (`/demo/synthetic/evaluate`, `/evaluate/synthetic`) are checked for
  **labelling and internal consistency only**. Their numbers mean nothing physically.
- Physical expectations are tested only when the real route returns `status: "computed"`. Until
  then those tests are BLOCKED, never passed. Examples: Earth never sets near (0°, 0°), the polar Sun
  stays within ≈1.6° of the horizon, elevation rate ≤ 0.6 °/h.
- Those bounds are textbook order-of-magnitude limits, not a validation. Validation needs JPL
  Horizons data recorded by a person (`fixtures/reference/`).
