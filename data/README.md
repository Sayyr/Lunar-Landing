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

## DEM (P1 — not yet selected)

Candidate: LOLA gridded polar products (south pole), PDS Geosciences Node / LOLA team, <https://lola.gsfc.nasa.gov/>.
Before use, record: product ID, projection (polar stereographic parameters), body-fixed frame (LOLA uses the mean-Earth/polar-axis system; confirm against the label), reference radius/datum, resolution, extent, and license/citation.
Only one small region should be stored locally.

## Provenance record (fill in when files are installed)

The web visualization datasets (LOLA `ldem_*.tif`, LROC colour mosaic, IAU gazetteer, Blue Marble) are fetched by
`apps/web/scripts/setup-data.sh` into `apps/web/public/data/`; see `apps/web/README.md`. Their rows below are still to be filled in.

| File | Source URL | Version/date | SHA-256 | Frame / datum | Coverage | License / citation | Installed by |
|---|---|---|---|---|---|---|---|
| _none yet_ | | | | | | | |
