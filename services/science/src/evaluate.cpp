#include "evaluate.hpp"

#include <cmath>
#include <cstdlib>

#include "intervals.hpp"

namespace selene {

namespace {

const std::vector<std::string> IDEAL_HORIZON_ASSUMPTIONS = {
    "Horizon model: ideal geometric horizon (elevation 0 deg); local terrain is ignored.",
    "Visibility = body centre above the horizon; finite apparent disks (partial Sun/Earth) "
    "are not modelled.",
    "Window edges are linearly interpolated between samples; events shorter than the "
    "sampling step may be missed.",
    "Geometric visibility only: Sun visibility is not a power guarantee and Earth visibility "
    "is not a radio-link guarantee.",
};

// Round half to even, like Python's timedelta constructor.
int64_t round_us(double us) { return static_cast<int64_t>(std::nearbyint(us)); }

json warnings(const ScenarioRequest& request, const EphemerisProvider& provider) {
    json out = json::array();
    if (provider.synthetic())
        out.push_back("SYNTHETIC DATA: these numbers do not describe the real Sun or Earth.");
    if (std::fabs(request.site.latitude_deg) >= POLAR_WARNING_LAT_DEG)
        out.push_back(
            "|latitude| >= 89.0 deg: local north/azimuth is ill-conditioned near the pole (azimuths change "
            "quickly with small site moves); at the pole itself north is taken along the requested longitude's "
            "meridian.");
    return out;
}

json windows(int64_t t0, const std::vector<double>& seconds, const std::vector<double>& elevation) {
    json out = json::array();
    for (const Interval& iv : extract_intervals(seconds, elevation, 0.0))
        out.push_back({
            {"start_utc", format_utc(t0 + round_us(iv.start * 1e6))},
            {"end_utc", format_utc(t0 + round_us(iv.end * 1e6))},
            {"clipped_start", iv.clipped_start},
            {"clipped_end", iv.clipped_end},
        });
    return out;
}

json response(const char* status, bool synthetic, const std::string& message,
              const ScenarioRequest& request, json model, json provenance, json assumptions,
              json warns, json samples, json sun_windows, json earth_windows) {
    return {
        {"schema_version", SCHEMA_VERSION},
        {"status", status},
        {"synthetic", synthetic},
        {"message", message},
        {"request", to_json(request)},
        {"model", std::move(model)},
        {"data_provenance", std::move(provenance)},
        {"assumptions", std::move(assumptions)},
        {"warnings", std::move(warns)},
        {"samples", std::move(samples)},
        {"windows", {{"sun_visible", std::move(sun_windows)}, {"earth_visible", std::move(earth_windows)}}},
    };
}

json not_ready(const ScenarioRequest& request, json model, const std::string& message, json warns) {
    return response("not_ready", false, message, request, std::move(model), json::array(),
                    json::array(), std::move(warns), json::array(), json::array(), json::array());
}

}  // namespace

std::vector<int64_t> sample_times(const ScenarioRequest& request) {
    const int64_t start = request.start_us();
    const int64_t step = round_us(request.step_minutes * 60e6);
    std::vector<int64_t> out;
    const long long n = request.sample_count();
    out.reserve(static_cast<size_t>(n));
    for (long long i = 0; i < n; ++i) out.push_back(start + i * step);
    return out;
}

json evaluate(const ScenarioRequest& request, const EphemerisProvider& provider) {
    json model = provider.model_info();
    json warns = warnings(request, provider);

    if (request.terrain_mode == "dem") {
        model["horizon_model"] = "dem_terrain";
        return not_ready(request, model, "DEM terrain horizon is not available yet (no DEM installed).",
                         warns);
    }

    const std::vector<int64_t> times = sample_times(request);
    DirectionSeries d;
    try {
        d = provider.directions(request.site, times);
    } catch (const EphemerisNotReady& e) {
        return not_ready(request, model, std::string("Ephemerides not available: ") + e.what(), warns);
    }

    const int64_t t0 = times.front();
    std::vector<double> seconds;
    json samples = json::array();
    for (size_t i = 0; i < times.size(); ++i) {
        seconds.push_back(static_cast<double>(times[i] - t0) / 1e6);
        samples.push_back({
            {"utc", format_utc(times[i])},
            {"sun", {{"azimuth_deg", d.sun_azimuth_deg[i]}, {"elevation_deg", d.sun_elevation_deg[i]}}},
            {"earth",
             {{"azimuth_deg", d.earth_azimuth_deg[i]}, {"elevation_deg", d.earth_elevation_deg[i]}}},
        });
    }

    json assumptions = json::array();
    for (const auto& a : provider.assumptions()) assumptions.push_back(a);
    for (const auto& a : IDEAL_HORIZON_ASSUMPTIONS) assumptions.push_back(a);

    const bool synthetic = provider.synthetic();
    return response(synthetic ? "synthetic" : "computed", synthetic,
                    synthetic ? "SYNTHETIC fixture output for UI development only."
                              : "Computed from SPICE ephemerides.",
                    request, model, provider.provenance(), assumptions, warns, samples,
                    windows(t0, seconds, d.sun_elevation_deg),
                    windows(t0, seconds, d.earth_elevation_deg));
}

}  // namespace selene
