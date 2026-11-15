# CLAUDE.md — SELENE / Lunar Landing Site Navigator

## Mission
Build **SELENE**, a scientifically defensible, interactive lunar landing-site and date comparison application for the 2026 NASA Space Apps Challenge, challenge **Lunar Landing Site Navigator**.

**Repository:** https://github.com/Sayyr/Lunar-Landing
**Team:** 6 contributors. **Infrastructure:** one Proxmox host, 32 logical CPUs, ~500 GB RAM, 300 GB disk. **Time:** hackathon, 14–15 November 2026. Optimize for a demonstrable end-to-end product, not maximum complexity.

## Read first
1. `CONTEXT.md` — mission, scope, priorities, milestones, interfaces.
2. `SCIENTIFIC_REFERENCE.md` — coordinate conventions, physical equations, accuracy levels, validation.
3. Existing code and tests before making changes.

## Non-negotiable rules
- Scientific correctness > flashy visuals > feature count. Never fabricate scientific results, ephemerides, measurements, mission suitability, or validation.
- Distinguish **ideal geometric horizon**, **DEM-based terrain horizon**, and **engineering power/link models** in data structures and UI.
- Do not label geometric Sun visibility as guaranteed electric power or geometric Earth visibility as a guaranteed radio link.
- Never invent NASA-provided DEMs, kernels, or validated landing sites. Record dataset origin, frame, datum, resolution, time coverage and license.
- Treat the 3D globe as a visualization of calculated results, not as the source of physical truth.
- Use UTC ISO 8601 at the API boundary; convert to SPICE ephemeris time with a leap-second kernel. State timescales and numerical assumptions.
- Use degrees in public JSON, radians internally; distances in meters at API boundary, SPICE kilometers internally; document every conversion.
- Lunar latitude is planetocentric; longitude is east-positive in [-180, 180). Explicitly document the chosen lunar body-fixed frame and DEM frame. Never silently mix MOON_ME, MOON_PA, IAU_MOON.
- Near poles, north/east conventions and azimuth can be ill-conditioned; implement and test deterministic polar handling.
- Keep CPU-intensive scientific work outside synchronous request handlers. Cache by site, dates, sampling interval, terrain mode and dataset/kernel versions.
- Do not download large datasets automatically. Use explicit setup scripts, checksums where possible, and small reproducible fixtures.
- No secrets, credentials, large DEMs, SPICE kernels, caches, or generated tiles in Git. Supply `.env.example`.
- Write tests for units, transforms, geometry, time intervals, API schemas and edge cases. Never report tests as passing unless executed.
- Do not push, force-push, rewrite history or modify remote settings without explicit user instruction.
- Avoid adding dependencies or architectural layers without clear immediate value.

## Stack and boundaries
- `apps/web`: React + TypeScript + Vite + React Three Fiber / Three.js; 3D, timelines, forms, side-by-side comparison. Use mock API fixtures until real services exist.
- `services/api`: Rust + Axum + Serde + Tokio; validates inputs, orchestrates calls, caches responses, exposes stable REST contracts. **No astronomy math duplicated here.**
- `services/science`: C++17 + CMake + cpp-httplib + nlohmann/json + CSPICE (optional, `scripts/setup-spice.sh`) + ctest; geometry, ephemerides, horizon, windows, optional scenario ranking.
- `services/sciencepy`: former Python implementation, kept for reference only. Not built, not tested, not deployed.
- `packages/contracts`: JSON Schema and sample request/response fixtures shared by services.
- `data/README.md`: external data provenance and acquisition instructions; data itself ignored.
- `docs`: scientific validation, design decisions, demo notes.
- `infra`: simple Docker Compose deployment. No Kubernetes.

## Proposed endpoints
- `GET /health`
- `GET /sites`
- `POST /scenarios/evaluate`
- `POST /scenarios/compare`
- `POST /scenarios/search` (after MVP)
- `POST /celestial/state` (SPICE geometric Sun/Earth/Moon state for the 3D views)
- `POST /scenarios/radio-link` (engineering tier: direct-to-Earth radio-link windows; analytic ephemeris, not SPICE)
- `GET /terrain/{site_id}` (after terrain availability)

### Minimum scenario input
```json
{
  "site": {"latitude_deg": -89.5, "longitude_deg": 0.0, "observer_height_m": 2.0},
  "start_utc": "2026-11-15T00:00:00Z",
  "duration_hours": 72,
  "step_minutes": 10,
  "terrain_mode": "ideal"
}
```
The example is synthetic; not a recommended landing site. Return an explicit `status`, `model`, `data_provenance`, `assumptions`, `warnings`, sample timestamps, Sun/Earth azimuth/elevation, and visibility windows. Mock responses must be unmistakably labeled `synthetic`.

## Work protocol for Claude Code
1. Inspect repository and these documents.
2. State the smallest executable milestone and its acceptance criteria.
3. Implement in small coherent changes; preserve service boundaries.
4. Run relevant tests, formatters and builds; report actual outcomes and blockers.
5. Summarize changed files, commands, unresolved scientific assumptions, and next handoff.
6. If a data dependency is missing, implement an honest stub/fixture and document the blocker; do not manufacture scientific outputs.

## Priority order
P0: running skeleton → validated Sun/Earth azimuth/elevation → visibility timeline → two-scenario comparison → deployed demo.
P1: lunar DEM terrain horizon → 3D local terrain → delay robustness search.
P2: solar array energy model, RF link budget, advanced optimization, high-fidelity dynamic shadows.

## Definition of done
A new contributor can start all three services from the README; a sample request flows web → Rust → C++ science (or a clearly labeled synthetic fixture before science is ready); tests execute; assumptions are visible; the demo remains functional without remote live NASA API availability.
