# Ground view — high-resolution south-polar relief (optional data)

Installed by `scripts/setup-polar-dem.sh` (not by `setup-data.sh`, not in Docker). Everything lands in
`data-raw/` (raw downloads) and `public/data/polar_s/` (served tiles), both git-ignored. Each tiled product
writes a `manifest.json` with its projection, validation result and provenance.

| Product | Source | Resolution / coverage | Frame, heights | Licence / credit | Validation |
|---|---|---|---|---|---|
| LOLA `LDEM_85S_20M` | PDS Geosciences Node, [lola_gdr/polar](https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/) (920 MB, size-checked) | 20 m/px, 85°S–90°S; tiled 20 m … 1280 m (7 levels) | MOON_ME DE421 (label), km relative to 1737.4 km | NASA PDS, public — credit NASA/GSFC LOLA team | Projection signs chosen against ldem_16 at 4000 random points: median \|Δh\| 28 m, RMS 56 m (ldem_16 is 1.9 km/px); wrong signs give 1.4–2.3 km. Shackleton ≈ 3.9 km floor-to-rim. |
| PGDA LOLA 5 m site DEMs (`Site01` connecting ridge, `Site04` Shackleton rim by default; `PGDA_SITES=…`) | [PGDA product 78](https://pgda.gsfc.nasa.gov/products/78), M. K. Barker (≈ 41 MB per site) | 5 m/px, 16 × 16 km per site; tiled 5 m and 10 m | MOON_ME DE421 (product page), metres in the GeoTIFF | NASA data, public — credit NASA/GSFC PGDA | GeoTIFF keys checked (polar stereographic, pixel-is-area, metres, k₀ = 1). Signs and unit chosen against `LDEM_85S_20M` inside the site: Site01 median 0.0 m / RMS 1.1 m, Site04 0.0 m / 2.1 m; the median offset is removed; refused above 15 m RMS or 5 m offset. |

Time coverage: LRO LOLA altimetry from 2009 on; the products do not state a cut-off date.

The ground view picks, at each distance, the level whose pixel matches the mesh sample spacing
(prefiltered data, no aliasing): 5 m site data only near the observer, then the 20 m pyramid out to 150 km,
then the global `ldem_16`.

Close-up surface texture is **procedural** (Wang tile bank, `src/lunar/wangBank.ts`) and labelled
illustrative in the view: no product above resolves the surface at the centimetre-to-metre scale.
