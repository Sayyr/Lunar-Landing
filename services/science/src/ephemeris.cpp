#include "ephemeris.hpp"

#include <cmath>

#include "geometry.hpp"

namespace selene {

ProviderStatus SpiceEphemerisProvider::status() const {
    std::string reason = "SPICE provider not implemented yet; CSPICE not linked into this build";
    if (!kernel_dir_)
        reason += "; SELENE_KERNEL_DIR not set";
    else if (!std::filesystem::is_directory(*kernel_dir_))
        reason += "; kernel directory " + kernel_dir_->string() + " does not exist";
    return {false, reason};
}

json SpiceEphemerisProvider::model_info() const {
    return {
        {"ephemeris_provider", "spice"},
        {"horizon_model", "ideal_geometric"},
        {"body_fixed_frame", nullptr},
        {"time_scale_note", "UTC at the API boundary; ET (TDB) via LSK once implemented."},
        {"kernel_set", json::array()},
    };
}

json SyntheticEphemerisProvider::model_info() const {
    return {
        {"ephemeris_provider", "synthetic_fixture"},
        {"horizon_model", "ideal_geometric"},
        {"body_fixed_frame", nullptr},
        {"time_scale_note", "Synthetic: UTC sample times only; no time-scale conversion performed."},
        {"kernel_set", json::array()},
    };
}

json SyntheticEphemerisProvider::provenance() const {
    return json::array({{
        {"name", "SELENE synthetic waveform generator"},
        {"kind", "synthetic"},
        {"source", "services/science/src/ephemeris.cpp"},
        {"version", "0.1.0"},
        {"license", nullptr},
        {"notes", "Arbitrary sinusoids. Not derived from any ephemeris, kernel or DEM."},
    }});
}

std::vector<std::string> SyntheticEphemerisProvider::assumptions() const {
    return {
        "SYNTHETIC: azimuth/elevation are arbitrary sinusoids (Sun period 36.0 h, Earth period "
        "60.0 h) chosen only to exercise the UI. They do not represent the Sun or Earth.",
        "SYNTHETIC: waveform phase depends on site longitude only so two scenarios look "
        "different; this dependence is not physical.",
    };
}

DirectionSeries SyntheticEphemerisProvider::directions(const Site& site,
                                                       const std::vector<int64_t>& times_us) const {
    DirectionSeries d;
    if (times_us.empty()) return d;
    const double phase = deg_to_rad(site.longitude_deg);
    for (int64_t t : times_us) {
        double hours = static_cast<double>(t - times_us.front()) / 1e6 / 3600.0;
        double sun_arg = 2 * PI * hours / SUN_PERIOD_H + phase;
        double earth_arg = 2 * PI * hours / EARTH_PERIOD_H + phase / 2;
        d.sun_azimuth_deg.push_back(wrap_azimuth_deg(rad_to_deg(sun_arg)));
        d.sun_elevation_deg.push_back(3.0 * std::sin(sun_arg) + 0.5);
        d.earth_azimuth_deg.push_back(wrap_azimuth_deg(180.0 + 5.0 * std::sin(earth_arg)));
        d.earth_elevation_deg.push_back(2.0 * std::sin(earth_arg));
    }
    return d;
}

}  // namespace selene
