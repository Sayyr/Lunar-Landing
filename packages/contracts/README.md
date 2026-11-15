# packages/contracts

JSON Schema (draft 2020-12) contracts shared by `services/api` (Rust), `services/science` (C++) and `apps/web` (TypeScript).
**The schemas are the source of truth.** The C++ models (`services/science/src/models.cpp`), the Rust serde types and `apps/web/src/api/types.ts` mirror them by hand.

| Schema | Used by |
|---|---|
| `schemas/scenario-request.schema.json` | `POST /scenarios/evaluate`, `POST /demo/synthetic/evaluate` (gateway); `POST /evaluate`, `POST /evaluate/synthetic` (science) |
| `schemas/scenario-response.schema.json` | the same endpoints, 200 responses |
| `schemas/error.schema.json` | every non-2xx response from both services |
| `schemas/health.schema.json` | `GET /health` on both services |
| `schemas/sites-response.schema.json` | `GET /sites` |
| `schemas/slope-check-request.schema.json` | `POST /terrain/slope/check` (gateway, under `/api/v1`; science, same path) |
| `schemas/slope-check-response.schema.json` | the same endpoints, 200 responses (`status`: `computed`, `out_of_coverage`, `dem_unavailable`) |
| `schemas/celestial-state-request.schema.json` | `POST /celestial/state` (gateway, under `/api/v1`; science, same path) |
| `schemas/celestial-state-response.schema.json` | the same endpoints, 200 responses (SPICE geometric Sun/Earth/Moon state for the 3D views); 503 + error envelope when ephemerides are unavailable |
| `schemas/celestial-tracks-response.schema.json` | `POST /celestial/tracks` (gateway, under `/api/v1`; science, same path; request body = `celestial-state-request`), 200 responses: SPICE Moon/Sun orbit traces for the 3D views; 503 + error envelope when ephemerides are unavailable |
| `schemas/radio-link-request.schema.json` | `POST /scenarios/radio-link` (gateway, under `/api/v1`); `POST /radio/evaluate` (science) |
| `schemas/radio-link-response.schema.json` | the same endpoints, 200 responses (engineering tier, `model.ephemeris_provider`: `analytic_meeus_truncated`) |
| `schemas/mission-simulate-request.schema.json` | `POST /scenarios/simulate`, `POST /demo/synthetic/simulate` (gateway, under `/api/v1`); `POST /mission/simulate`, `POST /mission/simulate/synthetic` (science) |
| `schemas/mission-simulate-response.schema.json` | the same endpoints, 200 responses (engineering tier: energy balance, contact, slope, constraints, verdict, corrections; `status`: `computed`, `synthetic`, `not_ready`) |

## Fixtures

- `fixtures/scenario-request.valid.json`: synthetic example from CLAUDE.md (not a recommended site).
- `fixtures/invalid-requests/*.json`: must be rejected by the schema, by the C++ science service and by the Rust gateway.
- `fixtures/scenario-response.*.json`: **generated** by `services/science/tools/generate_fixtures.cpp`. Do not hand-edit.
- `fixtures/slope-check-request.valid.json`: synthetic example zone (not a recommended site).
- `fixtures/invalid-slope-check-requests/*.json`: must be rejected by the schema, the C++ science service and the Rust gateway.
- `fixtures/slope-check-response.dem-unavailable.json` (no DEM configured) and `fixtures/slope-check-response.synthetic-dem.json`
  (**SYNTHETIC** 8° tilted-plane grid, `services/science/tests/synthetic_dem.hpp`, labelled `synthetic: true`): **generated** by
  `generate_fixtures.cpp`. Do not hand-edit. No fixture is computed from the real LOLA DEM (not in Git).
- `fixtures/radio-link-request.valid.json`: synthetic site, **illustrative** hardware figures and stations (no real system).
- `fixtures/invalid-radio-link-requests/*.json`: must be rejected by the schema, the C++ science service and the Rust gateway.
- `fixtures/radio-link-response.computed.json`: **generated** by `generate_fixtures.cpp` from the analytic ephemeris. Do not hand-edit.
- `fixtures/celestial-state-request.valid.json`, `fixtures/invalid-celestial-state-requests/*.json`: as above for `POST /celestial/state`.
- `fixtures/celestial-state-response.computed.json`, `fixtures/celestial-tracks-response.computed.json`: **generated** by `generate_fixtures.cpp` when `SELENE_KERNEL_DIR` holds the kernels (real SPICE output, DE440). Do not hand-edit.
- `fixtures/mission-simulate-request.valid.json`: synthetic site, **illustrative** vehicle figures (panels, battery, loads, radio) and stations (no real system).
- `fixtures/invalid-mission-simulate-requests/*.json`: must be rejected by the Rust gateway and the C++ science service, and by the schema
  except `too-many-samples.json` and `search-too-many-points.json` (sample / search-point caps a JSON Schema cannot express).
- `fixtures/mission-simulate-response.synthetic.json` (synthetic provider, `synthetic: true`) and `fixtures/mission-simulate-response.not-ready.json`
  (no kernels): **generated** by `generate_fixtures.cpp`. Do not hand-edit.
- `fixtures/sites.json`: served verbatim by the gateway (`include_str!`). Every entry needs a `source`. Real candidate regions need a citation.

## Changing a contract

1. Edit the schema and bump `schema_version` if the change breaks clients.
2. Update the C++ request parsing/response builders (`services/science/src/models.cpp`, `evaluate.cpp`, `terrain.cpp`, `radio.cpp`), Rust types (`scenario.rs`, `terrain.rs`, `radio.rs`, `mission.rs`) and TS types.
3. Regenerate the response fixtures (`cd services/science && cmake --build build --target generate-fixtures && ./build/generate-fixtures`).
4. Run `ctest --test-dir build` (live output vs fixtures) and `cargo test` (fixtures and gateway output vs schemas).
