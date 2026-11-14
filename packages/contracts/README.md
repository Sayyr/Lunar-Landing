# packages/contracts

JSON Schema (draft 2020-12) contracts shared by `services/api` (Rust), `services/science` (Python) and `apps/web` (TypeScript).
**The schemas are the source of truth.** The Pydantic models, the Rust serde types and `apps/web/src/api/types.ts` mirror them by hand.

| Schema | Used by |
|---|---|
| `schemas/scenario-request.schema.json` | `POST /scenarios/evaluate`, `POST /demo/synthetic/evaluate` (gateway); `POST /evaluate`, `POST /evaluate/synthetic` (science) |
| `schemas/scenario-response.schema.json` | the same endpoints, 200 responses |
| `schemas/error.schema.json` | every non-2xx response from both services |
| `schemas/health.schema.json` | `GET /health` on both services |
| `schemas/sites-response.schema.json` | `GET /sites` |

## Fixtures

- `fixtures/scenario-request.valid.json`: synthetic example from CLAUDE.md (not a recommended site).
- `fixtures/invalid-requests/*.json`: must be rejected by the schema, by Pydantic and by the Rust gateway.
- `fixtures/scenario-response.*.json`: **generated** by `services/science/scripts/generate_fixtures.py`. Do not hand-edit.
- `fixtures/sites.json`: served verbatim by the gateway (`include_str!`). Every entry needs a `source`. Real candidate regions need a citation.

## Changing a contract

1. Edit the schema and bump `schema_version` if the change breaks clients.
2. Update the Pydantic models, Rust types and TS types.
3. Regenerate the response fixtures (`cd services/science && .venv/Scripts/python scripts/generate_fixtures.py`, or `.venv/bin/python` on Linux/macOS).
4. Run `pytest` and `cargo test`. Both validate fixtures and live output against the schemas.
