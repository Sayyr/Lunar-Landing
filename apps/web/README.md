# apps/web — SELENE front-end

React + TypeScript + Vite. Two views, switched in the header (state kept in the URL hash):

| Tab | URL | What |
|---|---|---|
| **Site scenario** | `#/` | Interactive 3D Moon (LOLA relief, LROC colour, IAU feature names on hover, search). Clicking the surface selects the scenario site; the form sends it to the API. |
| **Sun · Earth · Moon** | `#/sky` | Pick a UTC date → Moon position relative to Earth and to the Sun, phase, 3D Earth–Moon and Sun–Earth–Moon views. **Mock data** for now (see below). |

The lunar explorer was ported from the former stand-alone `apps/moon-explorer` (vanilla JS); its logic is
unchanged, its UI text translated to English.

## Setup

```bash
cd apps/web
npm ci
scripts/setup-data.sh --light   # optional: NASA/IAU data into public/data/ (git-ignored); --light skips ldem_16 (66 MB)
npm run dev                     # http://localhost:5173  (?dem=4 or ?dem=16 forces the relief raster)
npm test && npm run typecheck && npm run build
```

`setup-data.sh` uses `wget` (falls back to `curl`), converts the colour mosaic with ImageMagick (fallbacks: `gdal_translate`,
then `sips` on macOS) and runs Python ≥ 3.11 (standard library only; choose the interpreter with
`PYTHON=/path/to/python3`). Raw downloads go to `data-raw/` (git-ignored, never served or bundled) together with
`SHA256SUMS` of the local install. Nothing is downloaded at run time.

Without the data the app still works: untextured / undisplaced spheres, no elevation or feature names, and a notice
in the UI telling you to run the script.

## Data

| File in `public/data/` | Source | Notes |
|---|---|---|
| `ldem_4.tif`, `ldem_16.tif` | [NASA SVS 4720 CGI Moon Kit](https://svs.gsfc.nasa.gov/4720), LOLA | Names unchanged. **Plain float32 TIFFs, not GeoTIFFs** (no GeoKeys): the georeferencing (row 0 = +90°, column 0 = −180°, "area" pixels) comes from the SVS documentation and was checked (on ldem_4: highest point 5.4° N 158.6° W, +10.5 km; minimum in Antoniadi, ≈ 70° S 172° W). Values in km relative to 1737.4 km. |
| `moon_color.jpg` | `lroc_color_poles_4k.tif` (LROC WAC, SVS 4720) | 4096×2048, converted to JPEG quality 90 (~2 MB). Also textures the Moon in the Sun·Earth·Moon dashboard. |
| `features.json` | [IAU/USGS Gazetteer](https://planetarynames.wr.usgs.gov) | There is no CSV URL usable from a script (the site's "CSV" button builds the file in the browser), so the script uses the official shapefile `MOON_nomenclature_center_pts.zip` and reads its `.dbf`. A hand-exported CSV also works: `python3 -I scripts/build_features.py export.csv public/data/features.json`. Longitudes 0–360° E converted to [−180, 180), "Dropped" features excluded. |
| `earth_bluemarble_2048.png` | [NASA SVS 2915 Blue Marble](https://svs.gsfc.nasa.gov/2915) | 2048×1024 equirectangular, lon −180° at the left edge. Dashboard only. |

**Not yet recorded** (CLAUDE.md requires them): the license / usage terms and the acquisition time coverage of each
product. Confirm them on the source pages above and add them, with the SHA-256 from `data-raw/SHA256SUMS`, to the
provenance table in `data/README.md` before publishing.

Credits: NASA's Scientific Visualization Studio (CGI Moon Kit, LRO LROC/LOLA data; Blue Marble); Gazetteer of Planetary
Nomenclature, IAU WGPSN / USGS Astrogeology. Cite these if the site is published.

## Lunar explorer — conventions and limits (`src/lunar/`)

- **Frame**: planetocentric latitude, east-positive longitude in [−180, 180). LOLA and the gazetteer are assumed to be in
  the same lunar frame (Mean Earth / Polar Axis); not re-checked at sub-km scale.
- **Scene axes** (`geo.ts`): lon 0° on +X, lon +90° E on −Z, north on +Y — the default three.js `SphereGeometry` UV
  mapping. `lib/sceneFrame.ts` uses the same axes.
- **Elevation**: relative to a 1737.4 km sphere (not a geoid, not height above local terrain). Bilinear interpolation,
  matching GPU filtering. Resolution ≈ 7.6 km/px (ldem_4) or ≈ 1.9 km/px (ldem_16) at the equator.
- **Feature shown**: the one whose centre is closest, among those whose circle (IAU diameter / 2) contains the point.
  Real outlines are not circular.
- **Picking**: without refinement the ray hits the *undisplaced* sphere; with strong exaggeration the read-out point can
  then be offset from the visible relief (warning in the panel). With "Pick on displayed relief" (default) a ray march on
  the CPU raster follows the relief up to mesh resolution. The sphere is intersected analytically (O(1)) rather than with
  `Raycaster` on ~500 k triangles; for the undisplaced sphere the result is identical.
- **Poles**: longitude is shown "—" within 1e-4° of a pole; the spatial index inspects all columns near the poles.
- **Memory**: the TIFF is downloaded, decoded into one `Float32Array`, then the raw buffer is released. Rows are flipped
  *in place* and the same array feeds the `DataTexture` (displacement + bump) and elevation look-ups: one CPU copy in
  steady state, shared across tab switches. Transient peak ≈ 2× while decoding. Changing quality reloads the page.
- **Ground view, south pole (optional, ~1.5 GB on disk)**: `scripts/setup-polar-dem.sh` downloads LOLA
  `LDEM_85S_20M` (PDS, 20 m/px, 85°S–90°S, MOON_ME DE421, 920 MB) and tiles it with `scripts/tile_polar_dem.py`
  (numpy) into `public/data/polar_s/` (20/40/80/160 m levels, uint16 with per-tile offset/step, quantisation ≤ cm).
  The label gives no projection signs: the tiler picks them by comparing with ldem_16 at 4000 random points and
  refuses to write tiles if the RMS exceeds 300 m (got: median |Δh| 28 m, RMS 56 m — ldem_16 is 1.9 km/px).
  Checked on Shackleton: ≈ 3.9 km floor-to-rim. The ground view loads ~190 tiles (~25 MB) around a site south of
  ≈ 85.1°S: 20 m to 6 km, 40 m to 25 km, 80 m to 80 km, 160 m to 150 km, then ldem_16. Not part of
  `setup-data.sh` nor the Docker build; `npm run build` copies `public/data/` into `dist/` as is.
- **ldem_16 streaming**: `setup-data.sh` splits `ldem_16.tif` (66 MB) with `scripts/split_ldem.py` into
  `public/data/ldem_16/band_NN.f32` (16 × 180 rows, raw float32 LE, **lossless**, already south-first) plus
  `manifest.json`. The app first shows ldem_4 (4 MB) resampled to the ldem_16 grid, then streams the bands (3 at a time,
  nearest to the selected site first); each band overwrites its rows in the same array and is uploaded alone to the GPU
  (`copyTextureToTexture`, no full re-upload). Until a band arrives, its latitudes show ldem_4 detail. Without a manifest,
  the single-file `ldem_16.tif` path is used.
- If the GPU can't do 5760 px textures, ldem_4 is used automatically. Without `OES_texture_float_linear`, relief is
  sampled "nearest".
- **Lighting is illustrative**: a fixed directional light, not the computed Sun direction.

### DOM events for the rest of the site

Emitted on the explorer root (`.lunar`), bubbling:

```js
document.addEventListener("moonhover", (e) => console.log(e.detail));
document.addEventListener("moonclick", (e) => {
  const { lat, lon, altM, feature } = e.detail; // feature: null | { name, type, diameterKm, lat, lon, distanceKm }
});
```

Interactions: mouse hover; click = marker + scenario site. Touch: tap = hover (tooltip), long press = marker + site.

## Sun · Earth · Moon state — SPICE, with a labelled mock fallback (`src/components/celestial/`, `src/mock/`)

`src/api/celestial.ts` is the single integration point for the dashboard, the globe lighting, the sky compass and
the ground view. It calls `POST /api/v1/celestial/state` (science service: CSPICE + DE440, geometric positions in
ECLIPJ2000, real lunar orientation; contract in `packages/contracts/schemas/celestial-state-response.schema.json`).
If that fails (no kernels on the server, services down, date outside 1849–2150) it returns
`src/mock/celestialMock.ts` instead, flagged `status: "synthetic"`, with the reason as first warning, and the UI
shows its SYNTHETIC labels. After a failure the backend is retried every 15 s. The orbit traces are always
low-precision browser curves (decorative), rotated to J2000 when the state is real.

The mock runs the **low-precision published formulae** (Astronomical Almanac Moon and Sun series, IAU 1982 GMST):

- Frame: geocentric ecliptic and mean equinox **of date** (not J2000 / ECLIPJ2000); TT = UTC + 69.184 s.
- Source-stated accuracy (spot-checked in `lowPrecisionEphemeris.test.ts` against Meeus' worked examples and the
  2024-04-08 / 2025-03-14 eclipses, not validated further): Moon λ 0.3°, β 0.2°; Sun λ 0.01° (1950–2050).
- 3D: Earth–Moon view has true distances (Earth/Moon radii optionally ×6), the Sun at a compressed distance with its true
  angular size; the Sun–Earth–Moon view is schematic, not to scale. Earth texture oriented by GMST + obliquity; Moon
  near side toward Earth (no libration). Shadows/eclipses are not rendered. The Sun is a procedural shader.

## Deployment

`npm run build` copies `public/data/` into `dist/data/`. The Docker image (`apps/web/Dockerfile`) runs
`scripts/setup-data.sh` (full, with ldem_16) in its own build stage, so the build needs network access to the SVS and
USGS servers; the local `public/data/` is ignored (`.dockerignore`).

- **Nginx** (`infra/nginx.conf`, rules ported from moon-explorer): `/data/*.tif|jpg|png` cached 1 year `immutable`
  with gzip for `image/tiff` (the uncompressed float TIFF compresses well); `features.json` 1 day; `/assets/` (hashed)
  immutable; HTML `no-cache`. `loaders.ts` switches to an indeterminate progress bar when the response is compressed.
- **Cloudflare Pages**: deploy `dist/` (`npx wrangler pages deploy apps/web/dist`); `public/_headers` is applied
  automatically. The ldem_16 bands (4.1 MB each) fit Pages' 25 MiB per-file limit; to host them elsewhere (R2, CDN, CORS
  allowed for your domain) set `VITE_LUNAR_DEM_BASE` at build time (the app reads `<base>ldem_16/manifest.json`).
