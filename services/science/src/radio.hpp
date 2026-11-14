// Direct-to-Earth radio-link windows for a lunar surface site (ENGINEERING tier).
//
// Mirrors packages/contracts/schemas/radio-link-{request,response}.schema.json.
//
// A link is reported available at an instant when ALL of these hold:
//   1. the Earth's centre is above the lunar-side antenna mask (ideal geometric horizon, no terrain);
//   2. at least one requested ground station sees the Moon above its own elevation mask;
//   3. the link budget closes (Eb/N0 - required Eb/N0 > 0) over that station's range.
// Geometry comes from lunar_ephemeris.hpp (analytic, low precision); the budget from link.hpp.
// Every hardware figure and every station comes from the request: nothing is assumed here.
#pragma once

#include <string>
#include <vector>

#include "link.hpp"
#include "models.hpp"

namespace selene {

constexpr int MAX_STATIONS = 8;

struct GroundStation {
    std::string name;
    double latitude_deg;       // geodetic (WGS84)
    double longitude_deg;      // east-positive, [-180, 180)
    double altitude_m;         // above the ellipsoid
    double min_elevation_deg;  // station elevation mask
};

struct RadioLinkRequest {
    ScenarioRequest scenario;  // site + time grid; terrain_mode is always "ideal" here
    double min_earth_elevation_deg;  // lunar-side antenna mask on the Earth's centre
    LinkParams link;
    std::vector<GroundStation> stations;
};

// Throws ValidationError with every issue found.
RadioLinkRequest parse_radio_link_request(const json& body);

// Returns a RadioLinkResponse JSON object (status = "computed").
json evaluate_radio_link(const RadioLinkRequest& request);

}  // namespace selene
