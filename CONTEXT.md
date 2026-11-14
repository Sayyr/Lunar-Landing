# CONTEXT.md — SELENE

## Project identity
**Name:** SELENE — Lunar Mission Feasibility Navigator (working name).
**Event:** 2026 NASA Space Apps Challenge, 14–15 November 2026.
**Official challenge:** Lunar Landing Site Navigator.
**Repository:** https://github.com/Sayyr/Lunar-Landing
**Team:** 6 people; responsibilities below are proposed roles, not assigned individuals.
**Infrastructure:** Proxmox machine with 32 logical CPUs, approximately 500 GB RAM and 300 GB storage.

## Problem statement
Lunar south-pole mission planners need to rapidly compare potential landing sites and dates, with special attention to the apparent positions of the Sun and Earth relative to the **local terrain horizon**. Sun visibility constrains potential solar energy; direct Earth line of sight constrains possible direct-to-Earth communication. Launch/landing delays can change the viability of a scenario. Existing tools (LROC QuickMap, Moon Trek, JPL Horizons) provide data but not necessarily fast, intuitive side-by-side scenario comparison.

## Product promise
A public-facing interactive 3D application to:
1. Pick a lunar site (preset or custom coordinates), date/time, and mission duration.
2. Display Moon globe and selected local terrain, with apparent Sun/Earth directions.
3. Plot azimuth/elevation versus time, and potential sunlight / Earth-visibility intervals.
4. Compare at least two site/date scenarios, with transparent quantitative differences.
5. Explore how a schedule delay affects windows and, if feasible, rank alternatives.

**Primary demo:** select south-polar site A, evaluate its windows; shift landing by several days; compare with site B or another date; explain the result with a timeline and local-horizon view.

## Success criteria
### P0 — must work
- Reproducible build and local run instructions for frontend, Rust gateway and Python science service.
- Validated topocentric Sun/Earth direction series for a lunar observer and specified UTC times.
- Ideal-horizon windows computed from real ephemerides, with provenance and limits displayed.
- Interactive 3D Moon selector and timeline linked to the same scenario.
- Side-by-side comparison of at least two scenarios.
- One scripted, reproducible demo; smoke tests and basic scientific validation.

### P1 — strong differentiators
- DEM-based horizon profile for a small, real lunar south-pole region; show terrain model provenance.
- Local 3D terrain matching the DEM and coordinate frame.
- Delay sensitivity analysis: compare shifts over a specified date range.
- Simple, explainable site/date ranking subject to user-defined constraints.

### P2 — only after P0/P1
- Solar array orientation and simplified power estimate.
- Earth antenna constraints / simplified communication link budget.
- Pareto-front multi-objective optimization, uncertainty sensitivity, detailed shadows, educational annotations.

## Architecture
```
apps/web (React + TS + Three.js / React Three Fiber)
       |
       | HTTP JSON
       v
services/api (Rust / Axum)
       |
       | HTTP JSON, internal network
       v
services/science (C++17 / cpp-httplib / nlohmann-json; CSPICE planned)
       |
       +--> NAIF SPICE kernels (local, versioned)
       +--> LOLA/LROC DEM (local selected regions, versioned)
```
Rust handles validation, orchestration and caching. The C++ science service owns scientific computations. Frontend renders results and must not independently calculate authoritative astronomy. Optional offline batch precomputation can use the available CPUs; avoid unnecessary cluster orchestration.

## Proposed repository layout
```
/
  CLAUDE.md
  CONTEXT.md
  SCIENTIFIC_REFERENCE.md
  INITIAL_PROMPT.md
  README.md
  .gitignore
  .env.example
  apps/web/
  services/api/
  services/science/
  packages/contracts/
  data/README.md
  docs/validation.md
  docs/demo.md
  infra/compose.yaml
  .github/workflows/ci.yml
```

## Six parallel workstreams (assign people locally)
1. **Ephemerides:** SPICE kernels, observer, Sun/Earth topocentric positions, reference comparisons.
2. **Terrain:** DEM acquisition, projections/frames, local horizon, shadow/visibility corrections.
3. **Rust API:** stable contracts, validation, science integration, cache and error handling.
4. **3D:** Moon globe, camera, selected coordinates, optional local terrain mesh.
5. **UX/DataViz:** site/date forms, timeline, comparison panels, warnings, accessibility.
6. **Integration/QA/demo:** environment, tests, deployment, numerical validation, pitch and submission.

## Timebox — working hours from kickoff
- H0–H1: monorepo scaffolding, service contracts, mock end-to-end demo.
- H1–H5: real ephemerides, verified time/coordinate conventions.
- H4–H8: visibility windows and timelines.
- H3–H10: 3D selection and two-scenario comparison in parallel.
- H5–H14: optional terrain horizon and local mesh.
- H10–H18: delay robustness / ranking if core is stable.
- H18–submission: feature freeze, testing, documentation, video and submission.

## Critical scientific decisions
- Lunar body-fixed reference frame must be explicitly chosen and matched to DEM metadata; do not assume two lunar frames coincide.
- Observer altitude and local surface normal must be defined; latitude/longitude and height must not be confused with DEM elevations.
- At the poles, local azimuth conventions need a deterministic definition; handle singularities.
- A visibility window is a **geometric potential** only. No atmosphere means no atmospheric refraction, but terrain and finite apparent solar/Earth disk sizes matter.
- Coarse temporal sampling can miss short visibility events; interpolate crossings or adaptively refine near boundaries.
- Horizons can be used for independent comparison, but do not require live external API for every user interaction.
- No single 'mission viability score' without transparent weights and constraints.

## Data sources (official challenge resources)
- JPL Horizons: https://ssd.jpl.nasa.gov/horizons/
- LROC QuickMap: https://quickmap.lroc.asu.edu/
- NASA Moon Trek: https://trek.nasa.gov/moon/
- NAIF SPICE docs: https://naif.jpl.nasa.gov/naif/documentation.html
- LOLA instrument: https://lola.gsfc.nasa.gov/

## Operational risks and mitigations
- **Kernel/frame mismatch:** record kernel set, frame, observer construction; cross-check results.
- **DEM data too large:** use one small region; do not commit datasets.
- **Frontend blocks on science:** start with labeled synthetic fixtures and contract tests.
- **Overbuilding Rust:** keep scientific computation in services/science.
- **Visual misrepresentation:** mark ideal vs terrain horizon and model resolution in UI.
- **Last-minute integration:** require running vertical slice by H8, freeze features by H18.

## What winning means here
A reproducible tool that directly solves the challenge, with credible data, clear uncertainty/assumptions, strong usability, and a compelling comparison of landing dates/sites. Do not claim NASA certification or flight-readiness.
