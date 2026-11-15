// Sun / Earth / Moon state at one instant, for the 3D views (Sun-Earth-Moon dashboard, globe
// lighting, sky compass). Mirrors packages/contracts/schemas/celestial-state-response.schema.json.
//
// Everything comes from CSPICE (spice.hpp) with the kernels of the scenario evaluation:
//  * Positions are GEOMETRIC (no light-time or aberration correction), so the three vectors are
//    mutually consistent (Sun->Moon = Earth->Moon - Earth->Sun) and place bodies in a scene. The
//    apparent, topocentric directions of a lunar site are served by POST /evaluate, not here.
//  * Frame: ECLIPJ2000 (ecliptic and equinox of J2000), geocentric origin. Right ascension and
//    declination of the Moon are in J2000 (ICRF axes).
//  * Orientation matrices: MOON_ME -> ECLIPJ2000 (real lunar orientation, librations included) and
//    IAU_EARTH -> ECLIPJ2000 (IAU rotation model of pck00011.tpc: good for drawing the globe, not
//    for Earth-fixed geodesy).
//  * Units at this boundary: metres and degrees (CSPICE kilometres x 1000, radians x 180/pi).
#pragma once

#include <cstdint>

#include "models.hpp"

namespace selene {

// Request body: {"utc": "2026-11-15T00:00:00Z"} (same UTC rules as a scenario start_utc).
// Throws ValidationError. Returns UTC microseconds since 1970.
int64_t parse_celestial_state_request(const json& body);

// Requires loaded kernels; throws spice::Error otherwise or when the epoch is outside the kernels.
json celestial_state(int64_t utc_us);

}  // namespace selene
