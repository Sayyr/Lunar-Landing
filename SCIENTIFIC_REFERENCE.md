# SCIENTIFIC_REFERENCE.md — SELENE mathematics and physics

This is an implementation-oriented scientific checklist, **not** a flight-qualified navigation model. Every formula has assumptions. Prefer validated NAIF/SPICE and geospatial libraries over manual reimplementation. Mark P0 (essential), P1 (terrain/robustness), P2 (extension).

## 0. Notation and conventions (P0)
- `φ`: planetocentric lunar latitude (radians); `λ`: east-positive lunar longitude (radians); `h`: observer height above the specified reference surface (km for SPICE).
- `t`: UTC input timestamp; `ET`: SPICE ephemeris time (TDB seconds past J2000), derived via LSK/SPICE.
- `R`: adopted spherical lunar reference radius, **only if** a spherical approximation is explicitly selected. A reference value near 1737.4 km is illustrative; select the radius/datum consistent with the chosen data.
- Body-fixed frame: select `MOON_ME` or an explicitly documented alternative consistent with lunar DEM. Do not mix frames silently.
- Topocentric ENU basis: east, north, up. Azimuth measured clockwise from north, 0° north/90° east; elevation positive above the local tangent plane. At exact poles, north is not unique: define a stable fallback tied to the body-fixed X axis and document it.
- Output angle degrees, distance meters, UTC ISO timestamps; internal SPICE radians, km, ET.
- Three model tiers: `ideal` (smooth reference sphere/ellipsoid), `terrain` (DEM horizon), `engineering` (hardware-specific assumptions).

## 1. Time and ephemeris transformations (P0)
1. Parse UTC with explicit timezone and reject ambiguous local timestamps.
2. Convert UTC -> ET/TDB using SPICE `str2et` with a leap-second kernel (LSK). **Do not** equate Unix seconds to ET or assume TDB=UTC.
3. Interpolate ephemeris vectors only with documented error bounds, otherwise query SPICE at each sample.
4. Obtain Sun and Earth apparent position vectors relative to a lunar surface observer via SPICE (`azlcpo`, or `spkcpo` + topocentric transform), with suitable SPK/PCK/FK/LSK kernels and documented light-time/stellar-aberration correction, e.g. `CN+S` where supported. The correction choice must match the target physical quantity and validation reference.
5. Record kernel names/versions, target IDs, observation epoch, reference frame and correction settings.
6. Verify that selected kernels actually cover the requested time span and frame transforms.

## 2. Lunar geographic -> body-fixed Cartesian (P0)
For an **explicit spherical approximation**:

`r = R + h`

`x = r cosφ cosλ`
`y = r cosφ sinλ`
`z = r sinφ`

If using an ellipsoid or DEM, derive the observer position and outward normal from the chosen datum/model; **do not** use spherical coordinates as an unannounced substitute for DEM elevations. A DEM grid may require map-projection inversion before these formulas apply.

Vector norm: `||v|| = sqrt(v_x²+v_y²+v_z²)`; unit vector: `v_hat = v / ||v||` for nonzero v.

## 3. Body-fixed frame -> local ENU (P0)
For nonpolar spherical planetocentric coordinates:

`east  = (-sinλ, cosλ, 0)`
`north = (-sinφ cosλ, -sinφ sinλ, cosφ)`
`up    = ( cosφ cosλ,  cosφ sinλ, sinφ)`

For observer-to-target vector `d` expressed in the **same** body-fixed frame:

`E = d · east`, `N = d · north`, `U = d · up`

`az = mod(atan2(E, N), 2π)`
`el = atan2(U, sqrt(E²+N²))`

For finite-range targets, use `d = r_target - r_observer`, not a geocentric vector that omits the observer displacement. SPICE `azlcpo` already implements a topocentric transformation with a documented convention; **do not apply ENU conversion twice**. Near exactly ±90° latitude, define north/east consistently with SPICE and test continuity.

## 4. Reference-frame transformations (P0)
- Rotation `d_fixed(t) = C_inertial_to_fixed(t) d_inertial(t)` where `C` is a time-dependent orthonormal matrix supplied by SPICE frame transforms (e.g. `pxform`), not a fixed hand-coded Moon rotation.
- Frame composition `C_A_to_C = C_B_to_C · C_A_to_B` (column-vector convention).
- Rigid local coordinates: `p_local = C_fixed_to_ENU · (p_fixed - p_observer)`.
- Verify handedness, axis order and longitude sign with simple tests at equator and south pole.
- For Three.js, explicitly map ENU or lunar-fixed coordinates to the renderer's Y-up axes. Visual transforms must not alter physical outputs.

## 5. Angular distance and finite apparent disks (P0/P1)
For two unit vectors: `θ = acos(clamp(u·v,-1,1))`.

Apparent angular radius of an approximately spherical target:
`α = asin(R_body / d)` for `d > R_body`, with target radius and distance in consistent units. For Sun/Earth, use appropriate radii and observer-target distance; Earth angular size varies with lunar geometry.

Given center elevation `el` and local horizon elevation `H(az)`:
- center above horizon: `el > H(az)`
- at least part of disk visible (approximation for locally smooth horizon): `el + α > H(az)`
- whole disk visible (approximation): `el - α > H(az)`.

For irregular terrain and a large apparent Earth disk, rigorous fractional visibility requires sampling the disk against the azimuth-dependent horizon. State whether center, any-limb or full-disk visibility is used. Atmospheric refraction is absent on the Moon.

## 6. Ideal horizon and geometric curvature (P0)
Ideal spherical local tangent horizon has `H(az)=0°` for an observer on the reference surface. For an observer elevated `h>0` above a smooth sphere, horizon depression relative to the horizontal tangent is:

`δ = acos(R/(R+h))`, so `H_ideal = -δ`.

For small h: `δ ≈ sqrt(2h/R)` radians. This does **not** include local terrain. Do not use negative depression blindly for a site inside a crater.

## 7. Terrain horizon from DEM (P1)
Input: lunar DEM with explicit projection, body-fixed frame, vertical datum, resolution and NoData handling.

For each azimuth `a` from the observer, trace terrain points at increasing distance and compute their elevation angle relative to the observer's local tangent plane:

`H(a) = max_j atan2(U_j, sqrt(E_j²+N_j²))`

where `(E_j,N_j,U_j)` are **observer-relative 3D** terrain point coordinates in local ENU. The trace must include spherical curvature; simply computing `atan((z_j-z_0)/horizontal_distance)` on a flat map fails at long distances. Define finite search radius and sampling spacing; report angular-resolution and DEM-coverage limits. A local near-field DEM alone may miss distant ridges. Include NoData/coverage flags, not silent zeros.

Alternative high-fidelity method: ray intersection against a triangulated terrain mesh or SPICE DSK (if available). Validate the ray model against the horizon profile.

For terrain shadow / illumination, test whether ray from point toward Sun intersects the terrain before reaching open sky; for an extended Sun, sample disk directions to estimate partial illumination.

## 8. Visibility and event times (P0)
Define a continuous visibility margin:

`m_sun(t) = el_sun(t) + α_sun(t) - H(az_sun(t))`
`m_earth(t) = el_earth(t) + α_earth(t) - H(az_earth(t))`

These are **any-part-of-disk** geometric visibility proxies; choose center/full-disk policy explicitly. Visible when margin > 0. For smooth horizon, set `H=H_ideal`.

On a sampled time grid, detect sign changes of margin. Refine event time with root finding (bisection/Brent) on the original physical model, not only linear interpolation. Tangential contacts may not produce a sign change; adaptively sample near extrema. Output UTC start/end, duration, longest blackout, visible fraction, and uncertainty due to time step/model resolution.

For interval union/intersection: sort endpoints; compute contiguous windows. Simultaneous sunlight **and** Earth visibility is the intersection of the two sets of intervals. For a mission requiring minimum uninterrupted duration `T_req`, filter windows by duration >= `T_req`.

## 9. Basic metrics and scenario comparison (P0)
Over mission interval `[t0,t1]`, length `T`:
- Sun visible fraction: `f_sun = (1/T) ∫ I_sun(t) dt`.
- Earth visible fraction: `f_earth = (1/T) ∫ I_earth(t) dt`.
- Joint visibility fraction: `f_joint = (1/T) ∫ I_sun(t) I_earth(t) dt`.
- Longest outage: max duration of contiguous `I(t)=0` intervals.
- Number of transitions, first sunrise/sunset, first Earthrise/Earthset.
- Difference across scenarios: `Δf_sun = f_sun,B - f_sun,A`, etc.
- Date-shift robustness: evaluate `f(t0+Δt)` over a specified delay range, report worst case and variance, not a hidden single score.

## 10. Solar-energy model (P2; engineering assumptions required)
Sun unit direction `s`, solar-panel normal `n`, panel area `A`, conversion efficiency `η`, incident irradiance `S(r)`:

`P_solar(t) = A η S(r(t)) max(0, n·s) × f_unobstructed(t)`.

`S(r) ≈ S_1AU (1 AU/r)^2`; use consistent physical constants and lunar heliocentric distance. Actual panel temperature, degradation, dust, electrical conversion and self-shadowing are excluded unless modeled. Solar elevation alone does not determine panel power.

Energy over window: `E = ∫ P_solar(t) dt`. For a simplified battery model: `dE_batt/dt = η_charge P_charge - P_load/η_discharge`, subject to `0 ≤ E_batt ≤ E_capacity`. Use time-stepping and report assumptions.

## 11. Direct-to-Earth communications (P0 geometry; P2 link budget)
- Geometric Earth line of sight requires appropriate Earth-disk/horizon visibility policy and no local obstruction.
- An antenna may also require pointing limits, elevation margin, and Earth-station availability. These are **not** implied by geometric visibility.
- Simplified free-space path loss: `FSPL_dB = 20 log10(4π d / λ_radio)` (distance `d` and radio wavelength `λ_radio` in the same units).
- Received power in dB units: `P_rx(dBW) = P_tx(dBW) + G_tx(dBi) + G_rx(dBi) - FSPL_dB - L_other(dB)`.
- Noise power: `N = k_B T_sys B`; `SNR = P_rx/N` in linear units, or corresponding dB difference. Real link budgets also require coding, polarization, pointing, margins, antenna/ground-station specifics and possibly occultation by terrain. Do not claim a usable link from LOS alone.

## 12. Scenario ranking and optimization (P1/P2)
- Hard constraints first: `longest_blackout ≤ limit`, `min_sun_fraction ≥ threshold`, `min_earth_fraction ≥ threshold`, etc.
- Compare remaining scenarios with explicit metrics. If using a weighted score, publish weights and normalization; avoid implying NASA-endorsed thresholds.
- Pareto dominance: A dominates B if A is no worse on every objective and strictly better on at least one.
- Delay robustness: evaluate candidate landing times `t0 + Δ`, possibly with uncertainty distribution `p(Δ)`; compute expected/worst-case metrics with declared assumptions.
- Search: grid over a limited curated region and date range first; optimize later. Use cache and batch parallelism. Avoid black-box ML unless it beats a documented baseline.

## 13. Geospatial math and 3D rendering (P1)
- Read DEM projection metadata and invert map projection to geodetic/planetocentric coordinates. South-pole products may use polar stereographic projection: use a validated GIS transform with the **correct lunar CRS/datum**, not an Earth EPSG code.
- Resample raster with known interpolation and NoData policy; derive a mesh with local coordinate origin to avoid floating-point jitter.
- Convert height grid to triangles; calculate normals using cross products; index shared vertices.
- Level of detail (LOD): chunking, downsampling and view-dependent mesh density; keep scientific horizon calculation independent of visual LOD.
- GPU shadow mapping can illustrate conditions, but only validated ray/horizon computations determine scientific visibility.
- Coordinate transform: `world_scene = scale × R_renderer_from_fixed × (p_fixed - p_origin)`; document axes, scale, and camera clipping.

## 14. Numerical methods and uncertainty (P1/P2)
- Sampling cadence sensitivity: compare 1-, 5-, 10-, 30-minute intervals for representative windows; event times should converge under refinement.
- Root finding: bracketed bisection or Brent for horizon crossings.
- Spatial DEM resolution sensitivity: downsample and compare horizon profiles/window metrics.
- Error propagation: for `m = el - H`, an approximate angular uncertainty `σ_m ≈ sqrt(σ_el² + σ_H²)` if independent; correlation may invalidate this shortcut.
- Monte Carlo: vary observer position, height, DEM elevation and schedule within documented uncertainty distributions; report distribution of metrics.
- Test corner cases: exact pole, longitude wrap, leap-second/time conversion, target near zenith (undefined azimuth), missing DEM tiles, polar night/day, disk grazing, short visibility windows, long-range horizon effects.

## 15. Validation plan (P0)
1. Unit tests: `deg ↔ rad`, `m ↔ km`, vector norms, ENU orthogonality, azimuth quadrants, longitude wrap, polar fallback.
2. SPICE tests: known kernel coverage, UTC->ET conversion, topocentric positions for one site/date; compare with JPL Horizons or an independent SPICE formulation using the **same observer and correction conventions**.
3. Sanity checks: all elevations in [-90°,90°], azimuth in [0°,360°), time monotonic, visible durations within [0,T], disjoint interval accounting.
4. Horizon tests: flat sphere `H≈0` at surface, known synthetic ridge blocks expected azimuth, elevated observer produces expected dip, NoData flagged.
5. Integration: same scenario parameters generate consistent 3D labels, timeline and comparison metrics.
6. Record provenance in every scientific result: kernels, frame, datum, DEM, sampling step, corrections, model tier, warnings.

## 16. Execution order
1. P0: freeze frames/units/time conventions and request/response schema.
2. P0: obtain compatible SPICE kernels; calculate real topocentric Sun/Earth directions.
3. P0: validate against independent reference; produce ideal-horizon windows.
4. P0: connect Rust and UI, compare two scenarios, demonstrate date shift.
5. P1: acquire one small DEM and implement correct terrain horizon; show ideal-vs-terrain differences.
6. P1: local 3D terrain, delay sensitivity and transparent ranking.
7. P2: panel energy, link budget, uncertainty and Pareto optimization only if stable.

## Primary references
- NAIF `azlcpo`: https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/azlcpo_c.html
- NAIF `spkcpo`: https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/spkcpo_c.html
- JPL Horizons: https://ssd.jpl.nasa.gov/horizons/
- LROC QuickMap: https://quickmap.lroc.asu.edu/
- NASA Moon Trek: https://trek.nasa.gov/moon/
- NAIF documentation: https://naif.jpl.nasa.gov/naif/documentation.html
