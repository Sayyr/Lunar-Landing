# Demo script

Works offline once installed: no live NASA API is called during the demo.
Sites below are **synthetic test points** (`packages/contracts/fixtures/sites.json`), not landing-site recommendations.

## Before the demo

1. `scripts/setup-spice.sh` once (CSPICE + SPICE kernels, SHA-256 checked; `--kernels` alone for Docker).
2. Start the stack: `docker compose -f infra/compose.yaml up --build`, or `scripts/dev.sh`.
3. Header badges must read **API**, **Science** and **Ephemerides ready**. If they say *NOT ready*, hover for the
   reason (usually: kernels not installed or `SELENE_KERNEL_DIR` not set) and fix that before going on.

## Main path (about 5 minutes)

1. **Pick site A.** Click the globe near the south pole, or choose the preset *SYN-A* (−89.5°, 0°E). Explain: planetocentric
   latitude, east-positive longitude, lunar frame `MOON_ME`.
2. **Evaluate (real ephemerides)**, 72 h, 10 min step. The card says `COMPUTED`:
   - Timeline of Sun and Earth centre elevation, with the above-horizon bars.
   - Model block: provider `spice`, frame `MOON_ME`, the five kernels, UTC → ET/TDB note.
   - Talking point: near the pole the Sun skims the horizon and the Earth rises and sets with the libration, over days,
     not hours.
3. **Delay the landing.** Open *Compare with scenario B*. Keep B's site = A's site and set *B start shift* to 7 days, then
   *Compare A and B*. The table shows, for A, B and B − A: Sun, Earth and joint visibility fractions, longest outages,
   window counts and first sunrise/Earthrise. Talking point: a one-week delay changes Earth visibility and the first
   Earthrise; the site is the same.
   Then open *Delay robustness*: 14 days, 1-day step, set e.g. *Min. Earth above horizon* 50 % and *Max. Earth outage*
   24 h, *Evaluate 15 delays*. The chart and table show which delays meet the constraints, the worst case and the spread;
   *Ranked* orders them by stated criteria (no weighted score). From SYN-A on 2026-11-15, delays of +0, +1 and +14 days fail.
4. **Another site.** Set B to −85°, −30°E and shift 0, compare again: more Earth, less Sun, different outages. Optional: B at
   0°, −180°E (far side) gives 0 % Earth and a 720 h outage over a 30-day span, a quick sanity check.
   **Terrain.** Set *Horizon model* to *DEM terrain horizon* and evaluate the floor of Shackleton crater
   (−89.67°, 129.8°E): the horizon profile shows walls 20° high all around and the Sun never rises (a permanently shadowed
   region), while the ideal horizon says "always lit". A ridge point (−89.45°, −137.3°E) keeps the Sun the whole time.
5. **Radio link** (engineering estimate). Open *Radio link to Earth*, *Compute radio windows*. Explain the three conditions
   (Earth above the lunar mask, a ground station sees the Moon, budget closes) and that it is not a link guarantee.
6. **Terrain.** Switch to the ground view at the site to show the LOLA relief and the shadows (visual only); the slope check
   gives a DEM-based pass/fail for a zone.

## What to say about limits

- With *Ideal geometric horizon*, terrain does not block the Sun or Earth. With *DEM terrain horizon* (needs the LOLA DEM,
  sites within 85°S–90°S) the skyline is traced on the 20 m relief up to 150 km; relief beyond the DEM is unknown and said so.
  The ground view is still a visualisation, not the scientific horizon.
- Visibility is of body **centres**; finite Sun/Earth disks are not modelled.
- Geometric Sun visibility is not power; geometric Earth visibility is not a radio link.
- Ephemerides: CSPICE + DE440, cross-checked against the team's SpiceyPy script and against JPL Horizons on 48 cases
  (`docs/validation.md`). The radio estimate uses an analytic ephemeris (≤ 0.04° from SPICE in our checks).
- Comparison metrics are computed in the browser from the windows returned by the science service (interval arithmetic
  only); outages touching the span edges are lower bounds.

## Fallback without kernels

*Evaluate* answers `NOT READY` with the reason and no numbers. *Load SYNTHETIC demo data* still shows the UI, with the orange
SYNTHETIC banner and watermark: say explicitly that those curves are not the Sun or Earth.
