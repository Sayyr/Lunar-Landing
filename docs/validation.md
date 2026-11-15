# Scientific conventions & validation

> **Status:** Sun/Earth azimuth/elevation now come from SPICE (`POST /evaluate`, CSPICE + DE440)
> when the service is built with CSPICE and given the kernels (`scripts/setup-spice.sh`). They are
> cross-checked against CSPICE's own `azlcpo` (internal consistency, same kernels) and against
> **JPL Horizons** (independent: DE441, Horizons' own pipeline): max 0.01 arcsec on 48 rows.
> `POST /evaluate/synthetic` remains SYNTHETIC.
>
> `SCIENTIFIC_REFERENCE.md` (named in CLAUDE.md as authoritative) is **not yet in the
> repository**. The conventions below are provisional and come from CLAUDE.md/CONTEXT.md.
> When the reference arrives, it takes precedence and this file must be reconciled with it.

## Conventions in force

| Topic | Convention | Where enforced |
|---|---|---|
| Public time | UTC, ISO 8601, literal `Z` suffix | schema pattern; Rust `is_utc_z`; Pydantic `UTC_PATTERN` |
| Internal time | ET/TDB seconds past J2000 via `str2et_c` + LSK `naif0012.tls` | `services/science/src/spice.cpp` (`spice::utc_to_et`) |
| Angles | degrees in JSON, radians internally | `geometry.deg_to_rad` / `rad_to_deg` at the boundary |
| Distances | meters in JSON, kilometers inside SPICE (÷1000 on input, ×1000 on output) | `spice.cpp` (`spice::site_position_km`: `height_m / 1000`) |
| Latitude | planetocentric, [-90, 90] | schema, Rust, Pydantic |
| Longitude | east-positive, [-180, 180); 180 is rejected on input, wrapped to -180 internally | schema, Rust, Pydantic, `wrap_longitude_deg` |
| Azimuth | from local north toward east, [0, 360) | `wrap_azimuth_deg`, response schema |
| Elevation | angle above the horizon model in `model.horizon_model` | response schema |
| `observer_height_m` | height above the local surface, NOT a DEM elevation or radius | schema description |
| Body-fixed frame | **MOON_ME** from `moon_de440_250416.tf` (= `MOON_ME_DE440_ME421`, mean Earth / polar axis aligned with DE421, the frame of the LOLA DEMs). Reported per response in `model.body_fixed_frame` (null = none used) | `ephemeris_spice.cpp`, response schema |
| Horizon model | `ideal_geometric` vs `dem_terrain`, always explicit | response `model.horizon_model` |
| Visibility | body **centre** above horizon; finite disks not modelled | assumptions list in every response |

Geometric visibility is **not** power availability and **not** a radio link. Every response's `assumptions` says so.

## Sampling and windows

- Samples: `start + k·step` for `k = 0 … floor(duration·60/step)`, inclusive of the start (and of the end when it falls on the grid). Max 20 000 samples (checked in both Rust and the C++ science service).
- Window edges: linear interpolation of the elevation crossing between bracketing samples (`intervals.extract_intervals`).
- `clipped_start` / `clipped_end`: the window was already open at the first sample, or still open at the last one. Its true duration is unknown.
- Known limitation: events shorter than one step can be missed. Planned fix: refine near sign changes (bisection or root-finding on the provider).

## Terrain horizon: choices and limits (2026-11-15)

- **Geometry**: for each of 720 bearings a ray is traced over the DEM along a great circle of the 1737.4 km sphere; the horizon is the largest `atan2((R+h_t)cos(d/R) − r_obs, (R+h_t)sin(d/R))`. Curvature is included; the observer stands on the DEM surface plus `observer_height_m`, and the ephemeris observer is placed at that radius.
- **Frame**: the DEM is used in its own frame (`MEAN EARTH/POLAR AXIS OF DE421`), which `MOON_ME` of `moon_de440_250416.tf` is aligned with; no conversion is applied.
- **Sampling**: 20 m to 3 km, 80 m to 25 km, 320 m to 150 km, point samples (not block maxima), ray step growing by 0.2 % of the distance. A narrow distant summit can be missed: the far horizon is a slight under-estimate. Not yet quantified by a resolution-sensitivity run (SCIENTIFIC_REFERENCE §14).
- **Coverage**: `LDEM_85S_20M` stops at 85°S. Rays leaving it are reported (`truncated_bearing_fraction`, a warning): relief north of 85°S is not included and could raise the horizon. Sites closer than 50 km to the edge are refused.
- **Visibility policy**: body centre above the horizon at its azimuth. Finite disks (the Sun's 0.27° radius, the Earth's 0.95°) are not modelled: near a grazing horizon the true partial visibility differs.

## Open scientific decisions (owner: Ephemerides workstream)

1. **Body-fixed frame**: decided, MOON_ME (see table). Same frame as the LOLA DEM label.
2. **Polar azimuth convention**: decided. The spherical ENU basis (`geometry.hpp` `enu_basis`) is used unchanged at |lat| = 90°, i.e. the limit along the requested longitude's meridian: at the south pole north points along meridian `lon`, at the north pole along `lon + 180`. Tested for continuity (lat −90 vs −89.9999999). Responses still warn when |lat| ≥ 89° because azimuths change quickly with small site moves.
3. **Aberration correction**: `CN+S` (converged Newtonian light time + stellar aberration), as in the team's `calcul_positions.py` and cross-checked with `azlcpo`. `CN+S` instead of the earlier `LT+S` proposal: same apparent-direction model, converged light time.
4. **Reference radius** for the observer: 1737.4 km sphere (PCK `pck00011.tpc` radii; the provider refuses to start if they differ) + `observer_height_m`. DEM local radius remains P1.

## Validation plan

| Check | Method | Tolerance (proposal) | Status |
|---|---|---|---|
| Unit/angle helpers | `services/science/tests/tests.cpp` (ctest) | exact / 1e-12 | ✅ automated |
| Window extraction | ctest incl. analytic sinusoid roots | 1e-5 rad on test signal | ✅ automated |
| Contract conformance | Rust tests vs `packages/contracts/schemas`; ctest checks live output matches the fixtures | exact | ✅ automated |
| UTC→ET | `spice_tests.cpp`: ET(2000-01-01T11:58:55.816Z) = 0 (J2000); 2016-12-31T23:59:59Z → 2017-01-01T00:00:00Z spans 2 s (leap second); ET − UTC = 69.184 s since 2017 (± \|TDB−TT\| < 2 ms); ET→UTC round trip to 1 µs | 1 ms (J2000), 1 µs (others) | ✅ automated 2026-11-15 |
| Lunar frames | `spice_tests.cpp`: MOON_ME→MOON_PA rotation orthonormal, det +1, constant in time, angle vs the FK's "approximately 0.02886 degrees" | 0.0005° | ✅ automated — measured 0.02886° |
| Sun/Earth az/el, internal consistency | `tests/spice_tests.cpp` (port of `test_validation_lunar_mission.py`): `spice::az_el` (`spkcpo_c` + ENU) vs `spice::az_el_azlcpo` (CSPICE `azlcpo_c`), 8 sites × 3 dates × {Sun, Earth} | 0.001° (as the Python script) | ✅ automated — 2026-11-15, measured max 1.1e-13° az, 1.4e-14° el |
| Sun/Earth az/el, team regression | same test: (−85°, −30°, 1.5 km), 2026-11-14 12:00 UTC → Sun az 150.4971° el −2.7963°, Earth az 28.0084° el 0.2914° (team's `calcul_positions.py`) | 0.01° | ✅ automated — reproduced to 4 decimals |
| Sun/Earth az/el at a lunar site, independent | JPL Horizons API, observer table, `coord@301` user site (MEAN_ME, 1737.4 km sphere, airless), quantity 4; lat/lon of the team's 8 sites, 2 m observer, same 3 epochs, Sun + Earth = 48 rows in `tests/integration/fixtures/reference/horizons/team_sites.csv` (query in `fetch_horizons.py`) | 0.01° (bench `TOLERANCE_DEG`) | ✅ 2026-11-15, bench `test_agrees_with_jpl_horizons` passes live; measured max 0.01 arcsec (2e-6°) az, < 0.005 arcsec el. Horizons uses DE441 and relativistic light bending, the service DE440 and CN+S |
| Polar handling | sites at lat ±90 (lon 0, 73, −150) finite and continuous with lat ±89.9999999; azimuth reference rotates with the requested longitude | 1e-4° | ✅ automated (`spice_tests.cpp`) |
| Long-period sanity | Sun elevation at a near-pole site stays within a few degrees of horizon; must be confirmed with real data, not assumed | qualitative | ⏳ |
| Analytic Moon position (`services/science/src/lunar_ephemeris.cpp`, used ONLY by the radio-link estimate) | Meeus worked example 47.a (1992-04-12 0h TD): longitude, latitude, distance | 0.01°, 0.01°, 60 km | ✅ automated — measured 0.0007°, 0.0006°, 35 km at that single epoch |
| Analytic optical librations (sub-Earth point) | Meeus worked example 53.a, same epoch | 0.02° | ✅ automated — measured < 0.001° |
| Greenwich mean sidereal time | Meeus worked example 12.a (1987-04-10 0h UT) | 1e-5° | ✅ automated |
| Analytic Earth direction at a lunar site vs SPICE | `spice_tests.cpp`: angular separation, same 8 sites × 3 dates as the team's script | expected ~0.1° (physical librations ≤ 0.04°, nutation, light time not modelled) | ✅ measured 2026-11-15: max 0.040° over 24 cases (test only asserts a gross bound < 1°). Radio-link windows still unverified against Horizons |
| Link-budget formulas (`services/science/src/link.*`, engineering tier) | FSPL vs the independent form `32.44778 + 20log10(d_km) + 20log10(f_MHz)`, inverse-square scaling, C/N0 and Eb/N0 identities, Doppler sign | 1e-4 dB | ✅ automated (formulas only) |
| Radio-link windows (`POST /radio/evaluate`) | sanity: sub-Earth equator always sees Earth, far side never, near-pole site ~half the time with multi-day outages, one station ≈ one pass/day, link ⊂ Earth ∩ ground windows, FSPL swing ≈ 1.1 dB | qualitative | ✅ automated (C++ suite + integration bench, live) |
| Mission simulation energy balance (`services/science/src/mission.cpp`, `POST /mission/simulate`) | `mission_tests.cpp`: panel power for the 3 pointings (cos i = 1, cos el, sin el); hand-computed battery trajectory with curtailment, discharge efficiency and unserved load; span intersection/gaps; pre-landing drain; a suggested battery size re-simulated to `go`; date scan with a test provider whose Sun follows absolute UTC: nearest passing date found (−3 h) and re-simulated to `go` | 1e-6 Wh | ✅ automated 2026-11-15 (203 checks). Model itself is a screening model (constant S0 = 1361 W/m², no thermal/dust/degradation); NOT validated against a real power system |
| Mission simulation, live | SPICE + `LDEM_85S_20M` horizon + 20 m slope: shadowed crater-floor site in Dec 2026 → 0 h Sun, battery reserve fails on day 1, `shorten_stay`/`resize_battery` re-simulated to `go`; well-lit ridge (−89.45°, −137.3°) Feb 2027 → 168 h Sun; Earth-gap failure fixed by `retime_landing` (+138 h); date scan ±15 d / 6 h (121 re-simulations, 1.0 s) finds the same nearest date (+5.8 d) and a second passing period 11–15 d earlier (Earth visibility cycle). Output validated against the JSON Schema | qualitative | ✅ manual 2026-11-15 |
| DEM terrain horizon (`services/science/src/horizon.cpp`) on SYNTHETIC DEMs | ctest: smooth sphere gives the geometric dip `-acos(R/(R+h))` in every direction; a 1000 m wall at 10 km and a 2 km parabolic pit match the exact curved-geometry elevation; azimuth convention follows the request longitude; windows are exactly the samples above the horizon; sites outside the DEM, within 50 km of its edge or on no-data are refused | 0.002° (sphere), 0.06–0.08° (one 100 m pixel) | ✅ automated |
| DEM terrain horizon on the real LOLA `LDEM_85S_20M` + SPICE | `spice_tests.cpp`, only when `SELENE_DEM_PATH` is set (not in CI): Shackleton floor (89.67°S, 129.8°E) at −2789 m, horizon ≥ 19.8° all around, Sun never visible over 30 days (known permanently shadowed region) while the ideal horizon says always lit; ridge point (89.45°S, 137.3°W) at +1955 m keeps the Sun 720 h of 720 | qualitative | ✅ executed 2026-11-15 (DEM SHA-256 `bbfd0295…9b7a`). Plausibility on known sites, **not a validation against published illumination maps** |
| Celestial state for the 3D views (`POST /celestial/state`) | `spice_tests.cpp`: distance ranges, Sun->Moon = Earth->Moon - Earth->Sun, orientation matrices equal `pxform` and are proper rotations, Moon +X within the librations of the Earth direction, obliquity 23.44°, almanac new Moon 2026-11-09 07:02 UTC and full Moon 2026-11-24 14:53 UTC (longitude difference < 0.05°) | see left | ✅ automated (needs kernels). Geometric positions, **not compared with JPL Horizons** for this endpoint |
| Web sky derived from that state (`moonSky`, compass, lighting) | vitest on the real fixture: unit vectors, Earth near +X, sub-solar latitude < 1.7° | qualitative | ✅ automated. Directions are from the Moon's centre (Earth parallax up to 0.26° at a site); the scenario evaluation is the reference |

Record every executed validation here with date, kernel set and SHA-256, and the result.

**Platforms tested on 2026-11-15** (full `ctest`, including `spice-tests`, with the kernels below): macOS arm64 (NAIF prebuilt and CSPICE built from source), Linux arm64 in Docker (built from source), Linux amd64 in Docker under emulation (NAIF prebuilt). Windows/MSVC (built from source) is covered by the `science-windows` CI job only; MinGW is not tested.

**Kernel set used for the 2026-11-15 runs** (NAIF generic kernels, fetched 2026-11-15 by `scripts/setup-spice.sh`, CSPICE N0067):

| File | SHA-256 |
|---|---|
| `naif0012.tls` | `678e32bdb5a744117a467cd9601cd6b373f0e9bc9bbde1371d5eee39600a039b` |
| `de440s.bsp` | `c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2` |
| `pck00011.tpc` | `3dff7b1dbeceaa01f25467767d3fa25816051c85d162d1edf04acb310ee28bb1` |
| `moon_pa_de440_200625.bpc` | `60cd55aa401ea2ea97360636f567554bfe4e37bb829f901b4460a455dfaf783f` |
| `moon_de440_250416.tf` | `a47c71e9c9f33796bdafb2c9d69a7ee447b6016ecad80f71cd6f3e479f9cf768` |
| CSPICE `MacM1_OSX_clang_64bit/cspice.tar.Z` | `0deae048443e11ca4d093cac651d9785d4f2594631a183d85a3d58949f4d0aa9` |
| CSPICE `MacIntel_OSX_AppleC_64bit/cspice.tar.Z` | `6f4980445fee4d363dbce6f571819f4a248358d2c1bebca47e0743eedfe9935e` |
| CSPICE `PC_Linux_GCC_64bit/cspice.tar.Z` (Linux x86_64 prebuilt; sources for Linux arm64) | `60a95b51a6472f1afe7e40d77ebdee43c12bb5b8823676ccc74692ddfede06ce` |
| CSPICE `PC_Windows_VisualC_64bit/cspice.zip` (sources, compiled by CMake) | `98d60b814b412fa55294aeaaeb7dab46d849cc87a8b709ffe835d08de17625dc` |
