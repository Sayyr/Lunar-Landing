# Reference data for az/el comparisons

**This folder ships no reference values.** The bench never invents NASA/JPL results.

## `horizons/` — JPL Horizons exports (independent reference)

One CSV per query, from <https://ssd.jpl.nasa.gov/horizons/> (observer table, center =
user-defined site on body 301, quantity 4 "apparent az/el"). First line is the header:

```
utc,body,latitude_deg,longitude_deg,observer_height_m,azimuth_deg,elevation_deg
```

then the exact query (site coordinates and their frame, time span, step, aberration settings,
Horizons version/date) in comment rows starting with `#` (the test skips rows whose `utc` starts
with `#`), then the data rows.

`horizons/team_sites.csv` (48 rows: the team's 8 sites x 3 epochs x Sun/Earth, 2 m observer) was
fetched from the Horizons API by `fetch_horizons.py`, which holds the exact query. Values are copied
verbatim. Re-run the script to refresh them; it records the fetch date in the file.

- `utc`: ISO 8601 with `Z`. `body`: `sun` or `earth`.
- Azimuth must be clockwise from north (Horizons default), elevation must be relative to the
  same horizon definition the backend uses (ideal geometric). State any difference in the header.

`test_reference.py::test_agrees_with_jpl_horizons` is **BLOCKED** when no such file exists.

## Team SPICE script (cross-implementation check, not a reference)

`resultats_validation.csv` at the repo root comes from `test_validation_lunar_mission.py`
(spkcpo vs azlcpo, `CN+S`, `MOON_ME`, sphere R = 1737.4 km). The bench reads it in place.
Agreement shows that two implementations using the same kernels agree. It does not validate either.

## Plausibility bounds used in `bench/invariants.py`

These are order-of-magnitude bounds from textbook lunar geometry. They catch gross errors
(wrong frame, degree/radian mix-ups, swapped bodies). They are **not** validation:

| Bound | Value | Basis |
|---|---|---|
| Max elevation rate | 0.6 °/h | Lunar sidereal rotation 360° / 655.7 h ≈ 0.55 °/h |
| Sun declination (lunar equator) | ≤ 1.6° | Lunar equator inclined ≈ 1.54° to the ecliptic |
| Earth declination (lunar body frame) | ≤ 7.5° | Latitude libration ≈ ±6.7° + topocentric parallax ≈ 0.26° |
| Earth visibility near (0°, 0°) / (0°, 180°) | always up / never up | Longitude libration ≈ ±7.9° |
