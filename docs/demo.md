# Demo script

## Current state (iteration 1 — skeleton)

Works offline. Needs no live NASA API.

1. Start the stack (`docker compose -f infra/compose.yaml up --build`, or `scripts/dev.sh`). See README.
2. Open the web app. Header badges show live status: **API**, **Science**, **Ephemerides NOT ready** (hover for the reason).
3. Click on the globe (drag to rotate) or choose a preset. Presets are synthetic test points, not landing sites. The red marker moves and the lat/lon fields update.
4. **Evaluate (real ephemerides)** → `NOT READY` card: the SPICE provider isn't implemented yet and no kernels are installed. No numbers are shown.
5. **Load SYNTHETIC demo data** → orange dashed panel with a "SYNTHETIC DEMO DATA" banner, watermark on the timeline, and the window list. Point out the assumptions and provenance sections.
6. Set horizon model to *DEM terrain horizon* → `NOT READY` (no DEM installed).

Talking point: the system refuses to show fake physics. Synthetic data exists only to build the UI and is labelled everywhere: response `status`, the `synthetic` flag, provenance, warnings, UI banner and watermark.

## Target demo (P0 complete) — to be written

Site A south-polar → windows over N days → shift landing by several days → compare with site B → explain with timeline and horizon view. Use only sites with cited coordinate sources.
