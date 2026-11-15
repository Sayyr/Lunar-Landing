#include "celestial.hpp"

#include <algorithm>
#include <cmath>

#include "geometry.hpp"
#include "spice.hpp"

namespace selene {

using namespace validate;

namespace {

const char* const SCENE_FRAME = "ECLIPJ2000";

double dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
double norm(const Vec3& a) { return std::sqrt(dot(a, a)); }
Vec3 minus(const Vec3& a, const Vec3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }

double angle_deg(const Vec3& a, const Vec3& b) {
    return rad_to_deg(std::acos(std::clamp(dot(a, b) / (norm(a) * norm(b)), -1.0, 1.0)));
}

double longitude_deg(const Vec3& v) { return wrap_azimuth_deg(rad_to_deg(std::atan2(v[1], v[0]))); }
double latitude_deg(const Vec3& v) { return rad_to_deg(std::asin(std::clamp(v[2] / norm(v), -1.0, 1.0))); }

// Vector in SCENE_FRAME, km -> {longitude, latitude, distance, position} in degrees and metres.
json relative(const Vec3& km) {
    return {
        {"longitude_deg", longitude_deg(km)},
        {"latitude_deg", latitude_deg(km)},
        {"distance_m", norm(km) * 1000.0},
        {"position_m", {km[0] * 1000.0, km[1] * 1000.0, km[2] * 1000.0}},
    };
}

json row_major(const spice::Mat3& m) {
    json out = json::array();
    for (const auto& row : m)
        for (double x : row) out.push_back(x);
    return out;
}

// Eight named phases by Moon - Sun ecliptic longitude difference (0 = new, 180 = full).
const char* phase_name(double elongation_lon_deg) {
    static const char* const NAMES[] = {"New Moon",  "Waxing crescent", "First quarter", "Waxing gibbous",
                                        "Full Moon", "Waning gibbous",  "Last quarter",  "Waning crescent"};
    return NAMES[static_cast<int>(std::fmod(wrap_azimuth_deg(elongation_lon_deg) + 22.5, 360.0) / 45.0) % 8];
}

}  // namespace

int64_t parse_celestial_state_request(const json& body) {
    if (!body.is_object()) throw ValidationError(std::vector<ErrorDetail>{{"", NOT_OBJECT}});
    std::vector<ErrorDetail> errs;
    int64_t utc_us = 0;
    auto utc = body.find("utc");
    if (utc == body.end()) {
        errs.push_back({"utc", "Field required"});
    } else if (!utc->is_string()) {
        errs.push_back({"utc", "Input should be a valid string"});
    } else {
        try {
            utc_us = parse_utc(utc->get<std::string>());  // pattern + impossible dates
        } catch (const std::invalid_argument& e) {
            errs.push_back({"utc", std::string("Value error, ") + e.what() +
                                       " (expected UTC ISO 8601 with a literal 'Z', e.g. 2026-11-15T00:00:00Z)"});
        }
    }
    reject_extra(body, {"utc"}, "", errs);
    if (!errs.empty()) throw ValidationError(std::move(errs));
    return utc_us;
}

json celestial_state(int64_t utc_us) {
    const double et = spice::utc_to_et(utc_us);
    const Vec3 moon = spice::geometric_position_km("MOON", "EARTH", SCENE_FRAME, et);  // Earth -> Moon
    const Vec3 sun = spice::geometric_position_km("SUN", "EARTH", SCENE_FRAME, et);    // Earth -> Sun
    const Vec3 moon_from_sun = minus(moon, sun);
    const Vec3 moon_equatorial = spice::geometric_position_km("MOON", "EARTH", "J2000", et);

    const double phase_angle = angle_deg(minus(sun, moon), minus(Vec3{0, 0, 0}, moon));  // Sun-Moon-Earth
    const double lon_difference = wrap_azimuth_deg(longitude_deg(moon) - longitude_deg(sun));

    json moon_from_earth = relative(moon);
    moon_from_earth["right_ascension_deg"] = longitude_deg(moon_equatorial);
    moon_from_earth["declination_deg"] = latitude_deg(moon_equatorial);

    json kernels = json::array();
    for (const spice::KernelFile& k : spice::required_kernels()) kernels.push_back(k.name);

    return {
        {"schema_version", SCHEMA_VERSION},
        {"status", "computed"},
        {"synthetic", false},
        {"utc", format_utc(utc_us)},
        {"frame",
         {{"name", "ECLIPJ2000 (geocentric origin)"},
          {"description", "Ecliptic and equinox of J2000. +X toward the J2000 equinox, +Z toward the north "
                          "ecliptic pole. Not the ecliptic of date."}}},
        {"moon_from_earth", moon_from_earth},
        {"moon_from_sun", relative(moon_from_sun)},
        {"sun_from_earth", relative(sun)},
        {"derived",
         {{"elongation_deg", angle_deg(sun, moon)},
          {"phase_angle_deg", phase_angle},
          {"illuminated_fraction", (1.0 + std::cos(deg_to_rad(phase_angle))) / 2.0},
          {"waxing", lon_difference < 180.0},
          {"phase_name", phase_name(lon_difference)}}},
        {"earth_orientation", row_major(spice::frame_rotation("IAU_EARTH", SCENE_FRAME, et))},
        {"moon_orientation", row_major(spice::frame_rotation(spice::FRAME, SCENE_FRAME, et))},
        {"model",
         {{"provider", "spice"},
          {"time_scale_note", "UTC at the API boundary; converted to ET (TDB seconds past J2000) by SPICE "
                              "str2et with the leap-second kernel."},
          {"nominal_accuracy", "JPL DE440 ephemeris through CSPICE; geometric positions (no light-time or "
                               "aberration correction). Not validated against JPL Horizons for this endpoint."},
          {"kernel_set", kernels}}},
        {"assumptions",
         {"Positions are geometric (no light-time, no aberration): consistent for placing bodies in a scene; "
          "the apparent directions of a lunar site come from the scenario evaluation.",
          "Moon seen from the Sun = (Earth->Moon) - (Earth->Sun).",
          "Illuminated fraction k = (1 + cos i)/2 with i the Sun-Moon-Earth phase angle (spherical Moon, no terrain).",
          "Moon orientation: MOON_ME (mean Earth / polar axis, DE440 lunar orientation, librations included).",
          "Earth orientation (texture only): IAU rotation model of pck00011.tpc (IAU_EARTH); no polar motion, "
          "no UT1-UTC."}},
        {"warnings", json::array()},
    };
}

}  // namespace selene
