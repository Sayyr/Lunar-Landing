# Scientific conventions & validation

> **Status: nothing has been scientifically validated yet.** The only numerical
> output today comes from the SYNTHETIC fixture provider and has no physical meaning.
>
> `SCIENTIFIC_REFERENCE.md` (named in CLAUDE.md as authoritative) is **not yet in the
> repository**. The conventions below are provisional and come from CLAUDE.md/CONTEXT.md.
> When the reference arrives, it takes precedence and this file must be reconciled with it.

## Conventions in force

| Topic | Convention | Where enforced |
|---|---|---|
| Public time | UTC, ISO 8601, literal `Z` suffix | schema pattern; Rust `is_utc_z`; Pydantic `UTC_PATTERN` |
| Internal time | ET/TDB seconds past J2000 via `str2et` + LSK | SPICE provider (not implemented) |
| Angles | degrees in JSON, radians internally | `geometry.deg_to_rad` / `rad_to_deg` at the boundary |
| Distances | meters in JSON, kilometers inside SPICE (÷1000 on input, ×1000 on output) | SPICE provider (not implemented) |
| Latitude | planetocentric, [-90, 90] | schema, Rust, Pydantic |
| Longitude | east-positive, [-180, 180); 180 is rejected on input, wrapped to -180 internally | schema, Rust, Pydantic, `wrap_longitude_deg` |
| Azimuth | from local north toward east, [0, 360) | `wrap_azimuth_deg`, response schema |
| Elevation | angle above the horizon model in `model.horizon_model` | response schema |
| `observer_height_m` | height above the local surface, NOT a DEM elevation or radius | schema description |
| Body-fixed frame | **undecided**; proposed MOON_ME (LOLA products use mean-Earth/polar-axis). Reported per response in `model.body_fixed_frame` (null = none used) | response schema |
| Horizon model | `ideal_geometric` vs `dem_terrain`, always explicit | response `model.horizon_model` |
| Visibility | body **centre** above horizon; finite disks not modelled | assumptions list in every response |

Geometric visibility is **not** power availability and **not** a radio link. Every response's `assumptions` says so.

## Sampling and windows

- Samples: `start + k·step` for `k = 0 … floor(duration·60/step)`, inclusive of the start (and of the end when it falls on the grid). Max 20 000 samples (checked in both Rust and the C++ science service).
- Window edges: linear interpolation of the elevation crossing between bracketing samples (`intervals.extract_intervals`).
- `clipped_start` / `clipped_end`: the window was already open at the first sample, or still open at the last one. Its true duration is unknown.
- Known limitation: events shorter than one step can be missed. Planned fix: refine near sign changes (bisection or root-finding on the provider).

## Open scientific decisions (owner: Ephemerides workstream)

1. **Body-fixed frame**: MOON_ME vs MOON_PA, and the matching FK/PCK. Must match the DEM frame.
2. **Polar azimuth convention**: at |lat| = 90° local north is undefined, and near the pole it is ill-conditioned. A deterministic rule is needed, e.g. "at the pole, azimuth reference = direction of the lon = 0 meridian". Responses currently warn when |lat| ≥ 89°.
3. **Aberration correction**: proposed `LT+S` (apparent direction) for Sun and Earth; document and test.
4. **Reference radius** for the observer: mean lunar radius from the PCK vs DEM local radius (P1).

## Validation plan (not executed yet)

| Check | Method | Tolerance (proposal) | Status |
|---|---|---|---|
| Unit/angle helpers | `services/science/tests/tests.cpp` (ctest) | exact / 1e-12 | ✅ automated |
| Window extraction | ctest incl. analytic sinusoid roots | 1e-5 rad on test signal | ✅ automated |
| Contract conformance | Rust tests vs `packages/contracts/schemas`; ctest checks live output matches the fixtures | exact | ✅ automated |
| UTC→ET | compare `str2et` to NAIF-documented example values | < 1 ms | ⏳ |
| Sun/Earth az/el at a lunar site | JPL Horizons topocentric observer on body 301 (user-defined site), same epochs and frame assumptions; store small reference CSVs in `services/science/tests/fixtures/` with the query used | proposal: < 0.01° | ⏳ |
| Polar handling | sites at lat −90, −89.999, −89.5 produce finite, continuous az/el | deterministic | ⏳ |
| Long-period sanity | Sun elevation at a near-pole site stays within a few degrees of horizon; must be confirmed with real data, not assumed | qualitative | ⏳ |

Record every executed validation here with date, kernel set and SHA-256, and the result.
