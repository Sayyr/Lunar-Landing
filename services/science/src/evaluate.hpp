// Scenario evaluation: time grid -> provider directions -> visibility windows.
#pragma once

#include <cstdint>
#include <vector>

#include "ephemeris.hpp"
#include "horizon.hpp"
#include "models.hpp"

namespace selene {

constexpr double POLAR_WARNING_LAT_DEG = 89.0;

// UTC microseconds of start + k*step for k = 0 .. sample_count()-1.
std::vector<int64_t> sample_times(const ScenarioRequest& request);

// What terrain_mode "dem" needs. dem == nullptr (or no context at all): the DEM mode answers
// not_ready with `unavailable_reason`; nothing is computed.
struct TerrainContext {
    const Dem* dem = nullptr;
    std::string unavailable_reason = "no DEM installed";
    HorizonCache* cache = nullptr;  // optional
};

// Returns a ScenarioResponse JSON object (status computed / synthetic / not_ready).
//  * terrain_mode "ideal": visible = body centre above elevation 0 deg.
//  * terrain_mode "dem": visible = body centre above the DEM terrain horizon at its azimuth
//    (horizon.hpp). The observer stands on the DEM surface (+ observer_height_m). Each sample then
//    carries `horizon_elevation_deg` and the response a `terrain_horizon` block with the profile.
//    Elevations themselves keep their meaning (angle above the local horizontal plane).
json evaluate(const ScenarioRequest& request, const EphemerisProvider& provider,
              const TerrainContext& terrain = {});

}  // namespace selene
