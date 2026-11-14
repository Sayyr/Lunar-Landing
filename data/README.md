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

## SPICE kernels (planned — not yet installed)

Source: NAIF generic kernels, <https://naif.jpl.nasa.gov/pub/naif/generic_kernels/>.
Documentation: <https://naif.jpl.nasa.gov/naif/documentation.html>.

| Purpose | Directory on NAIF server | Candidate file | Status |
|---|---|---|---|
| Leap seconds (UTC→ET) | `lsk/` | `naif0012.tls` | to fetch; confirm it is the latest LSK |
| Planetary ephemeris (Sun/Earth/Moon) | `spk/planets/` | `de440s.bsp` (smaller) or `de440.bsp` | to fetch; choose and record |
| Generic body constants (radii) | `pck/` | `pck00011.tpc` | to fetch |
| Lunar orientation (high precision) | `pck/` | `moon_pa_de440_*.bpc` | **verify exact filename** |
| Lunar frames (MOON_PA / MOON_ME) | `fk/satellites/` | `moon_de440_*.tf` (+ `moon_assoc_me.tf` if used) | **verify exact filename** |

Filenames marked "verify" must be checked against the live NAIF directory listing. Don't trust this table until it has been checked.

### Acquisition procedure (manual)

1. Download each file into `data/kernels/` (browser, `curl -O`, or `wget`).
2. Record SHA-256: `sha256sum data/kernels/* > data/kernels/SHA256SUMS` (commit the checksums to `docs/validation.md`, not the files).
3. Write `data/kernels/selene.tm` (meta-kernel) listing the files with `PATH_VALUES`/`PATH_SYMBOLS`.
4. Fill in the provenance table below.

## DEM for the science service (terrain slope check)

`POST /terrain/slope/check` reads the raw LOLA `LDEM_85S_20M` float32 grid. It is the same file the web
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
| _none yet_ | | | | | | | |
