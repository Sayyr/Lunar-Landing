# data/ — external datasets (not in Git)

Everything in this folder except this README and `kernels/.gitkeep` is git-ignored.
**Nothing is downloaded automatically.** Fetch files explicitly, verify them, and record them in the table below.

## Layout

```
data/
  kernels/          SPICE kernels + a meta-kernel (selene.tm). Mounted read-only into the science container.
  dem/              (later) one small LOLA south-pole region, with its label/metadata file.
```

The science service reads `SELENE_KERNEL_DIR` (default in Docker: `/data/kernels`).

## SPICE kernels

Install with `scripts/setup-spice.sh` (kernels into `data/kernels/` + `SHA256SUMS`, CSPICE into
`services/science/third_party/cspice/`; ~88 MB, checksums verified). Same set as the team's
`calcul_positions.py`. NAIF publishes no checksums for these files: the SHA-256 values in the script and
in `docs/validation.md` were recorded from the NAIF server on 2026-11-15.

Source: NAIF generic kernels, <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/>.
Documentation: <https://naif.jpl.nasa.gov/naif/documentation.html>.

| Purpose | File (NAIF path) | Coverage / notes |
|---|---|---|
| Leap seconds (UTC→ET) | `lsk/naif0012.tls` | last leap second 2017-01-01 |
| Planetary ephemeris (Sun/Earth/Moon) | `spk/planets/de440s.bsp` | DE440, 1849-12-26 to 2150-01-22; requests outside → `not_ready` with the SPICE error |
| Generic body constants (radii) | `pck/pck00011.tpc` | Moon radii 1737.4 km (checked at startup) |
| Lunar orientation (high precision) | `pck/moon_pa_de440_200625.bpc` | MOON_PA_DE440 |
| Lunar frames (MOON_PA / MOON_ME) | `fk/satellites/moon_de440_250416.tf` | MOON_ME = MOON_ME_DE440_ME421 (DE421-aligned mean Earth / polar axis) |

Set `SELENE_KERNEL_DIR` to `data/kernels` (`scripts/dev.sh` does it automatically when the kernels are there).
The service loads exactly these five files by name; the response lists them in `model.kernel_set` and
`data_provenance` (with the SHA-256 read from `SHA256SUMS`, not recomputed).

## DEM for the science service (terrain slope check and terrain horizon)

`POST /terrain/slope/check` and `POST /evaluate` with `terrain_mode: "dem"` (terrain horizon, `services/science/src/horizon.hpp`) read the raw LOLA `LDEM_85S_20M` float32 grid. It is the same file the web
polar tiles are built from (`apps/web/scripts/setup-polar-dem.sh` downloads it to `apps/web/data-raw/lola_polar/`,
see `apps/web/scripts/POLAR_DATA.md`); nothing is downloaded by the service.

| Item | Value (from the PDS label) |
|---|---|
| Product | `LDEM_85S_20M` V2.1, data set `LRO-L-LOLA-4-GDR-V1.0`, LRO LOLA team / NASA GSFC |
| Source | <https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/> (`ldem_85s_20m_float.img` + `.lbl`) |
| Grid | 15168 × 15168 float32 (PC_REAL), heights in km relative to a 1737.4 km sphere, 20 m/px true at the pole |
| Projection | polar stereographic (sphere), centre 90°S 0°E, offsets 7583.5 px |
| Frame | `MEAN EARTH/POLAR AXIS OF DE421`; latitude planetocentric, longitude east-positive |
| Coverage | 85°S–90°S (label `MAXIMUM_LATITUDE`); zones crossing −85° or the grid edge → `out_of_coverage` |
| Time | LOLA altimetry 2009-07-13 … 2017-02-02 (label START/STOP_TIME) |
| SHA-256 | `bbfd0295c7ae0759dd7b2513e1ebd61fd5e3d304e35b3fa2ae9e6840054d9b7a` (`.img`, from `SHA256SUMS` next to the file) |
| License | NASA PDS, public; credit NASA/GSFC LOLA team |

Configure with `SELENE_DEM_PATH=/abs/path/ldem_85s_20m_float.img` (label auto-detected; `SELENE_DEM_LABEL`
overrides). At startup the service checks the label (south polar stereographic sphere, float32 km, no rotation)
and the file size, and records the SHA-256 listed in `SHA256SUMS` (not recomputed). Each request reads only the
rows of the window around the zone (≤ ~1000 × 1000 px for the 10 km maximum radius). Without a usable DEM
the endpoint answers HTTP 200 with `status: "dem_unavailable"` and computes nothing.
Response `data_provenance` copies the label's identification keywords (PRODUCT_ID, DATA_SET_ID, PRODUCER_*, …;
null when absent). The PDS URL, licence and GMT-interpolation caveat are added only when `DATA_SET_ID` identifies
an LRO LOLA GDR product; any other DEM gets a warning that its origin and licence are not recorded.
Results are cached in memory (LRU, 256 entries) by normalized request + DEM identity (product id, file size,
mtime, recorded SHA-256).

The DEM-scale slope (20 m grid, Horn 3×3 ≈ 60 m window) is **not** lander-footprint slope; a `pass` is a
screening result, not a validated landing site.

## Provenance record (fill in when files are installed)

The web visualization datasets (LOLA `ldem_*.tif`, LROC colour mosaic, IAU gazetteer, Blue Marble) are fetched by
`apps/web/scripts/setup-data.sh` into `apps/web/public/data/`; see `apps/web/README.md`. Their rows below are still to be filled in.

| File | Source URL | Version/date | SHA-256 | Frame / datum | Coverage | License / citation | Installed by |
|---|---|---|---|---|---|---|---|
| `data/kernels/*` (5 SPICE kernels) | see table above | NAIF generic kernels as of 2026-11-15 | `data/kernels/SHA256SUMS`, `docs/validation.md` | MOON_ME (FK above) | see table above | NASA/JPL NAIF, distributed publicly; no licence statement in the files | `scripts/setup-spice.sh` |
