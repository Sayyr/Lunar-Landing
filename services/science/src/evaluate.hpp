// Scenario evaluation: time grid -> provider directions -> visibility windows.
#pragma once

#include <cstdint>
#include <vector>

#include "ephemeris.hpp"
#include "models.hpp"

namespace selene {

constexpr double POLAR_WARNING_LAT_DEG = 89.0;

// UTC microseconds of start + k*step for k = 0 .. sample_count()-1.
std::vector<int64_t> sample_times(const ScenarioRequest& request);

// Returns a ScenarioResponse JSON object (status computed / synthetic / not_ready).
json evaluate(const ScenarioRequest& request, const EphemerisProvider& provider);

}  // namespace selene
