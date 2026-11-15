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

## Derived slope / aspect tiles (`public/data/polar_s_slope/`, git-ignored)

Generated offline from the raw `LDEM_85S_20M` float32 file (not from the quantised `polar_s` tiles) by
`services/science/tools/slope_tiles.cpp`:

```sh
cmake -S services/science -B services/science/build -DOpenMP_ROOT=$(brew --prefix libomp)  # OpenMP optional
cmake --build services/science/build --target slope-tiles
D=apps/web/data-raw/lola_polar
services/science/build/slope-tiles $D/ldem_85s_20m_float.img $D/ldem_85s_20m_float.lbl \
  apps/web/public/data/polar_s_slope --source-sha256 "$(grep ' ldem_85s_20m_float\.img$' $D/SHA256SUMS | cut -d' ' -f1)"
# options: --baseline 3 (60 m DEM block mean), --levels 7, --no-aspect, --flat-tan 1e-4
```

Same tile layout as `polar_s` (256 px, L0..L6, 8-byte header float32 offset, step; uint16 LE; 65535 = no data)
but in **degrees**, under `slope/` and `aspect/`. Horn 3x3 gradient on the native polar-stereographic grid with the
pixel spacing corrected for the stereographic scale factor k = 2/(1+cos colatitude) (true at the pole) and for
height above the 1737.4 km sphere. Aspect = steepest-descent direction clockwise from image-up (grid aspect);
convert to geographic azimuth with `az_geo = (az_grid − lon_E) mod 360` (validated signs). Coarser levels keep
the **max** slope of the 2×2 children (conservative for hazard display). The 20 m-baseline slope is **not**
lander-footprint (metre-scale) slope. Full conventions and provenance: `manifest.json` and
`services/science/src/slope_core.hpp`.

## 4 km disc slope grid (`public/data/polar_s_grid/grid_4km.json`, git-ignored)

Used by the "South-pole grid" page. Generated offline from the same raw float32 file by
`services/science/tools/slope_grid.cpp` (~2 s, 2.8 MB JSON):

```sh
cmake --build services/science/build --target slope-grid
D=apps/web/data-raw/lola_polar
services/science/build/slope-grid $D/ldem_85s_20m_float.img $D/ldem_85s_20m_float.lbl \
  apps/web/public/data/polar_s_grid/grid_4km.json --source-sha256 "$(grep ' ldem_85s_20m_float\.img$' $D/SHA256SUMS | cut -d' ' -f1)"
# options: --diameter-m 4000, --grids 2 (1-4 offset grids), --bin-deg 0.5, --max-deg 60
```

Same unquantised Horn 20 m slope as the tiles (`slope_core.hpp`). Disc centres on a square grid of step = diameter in
polar-stereographic map coordinates; grid 2 is shifted by half a step in x and y, so grids 1 + 2 together cover the
whole area (covering radius = disc radius). Disc radius is a ground distance (map radius × k). Only discs fully inside
85°S. Per disc: 0.5° slope histogram, valid/no-data counts, mean, max. Check on 2026-11-15: share of pixels > 10° over
all discs of a grid 42.0 % vs 42.4 % for the whole L0 tile set (the tiles also include the square's corners).
Layout and conventions: `services/science/src/slope_grid.hpp` and the file's `method` block.

Docker / server: like `polar_s` and `polar_s_slope`, the file is not in the image; `infra/compose.yaml` mounts
`apps/web/public/data/polar_s_grid/` read-only into nginx. Generate it on the host (command above, needs the raw
`LDEM_85S_20M` from `setup-polar-dem.sh`), or copy the 2.8 MB file from a machine that has it, then
`docker compose -f infra/compose.yaml up -d web` (the mount is only picked up when the container is recreated).

The "Verify on server" button of the slope map does not use these tiles: it calls `POST /api/v1/terrain/slope/check`,
which recomputes the same Horn slope (same code, `services/science/src/slope_core.hpp`) on the raw float32 file
for every pixel of the zone (`SELENE_DEM_PATH`, see `data/README.md`). Spot check: server slopes at three worst
pixels matched the L0 tiles within 0.0007° (uint16 quantisation).
