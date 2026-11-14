#include "geometry.hpp"

#include <cmath>
#include <stdexcept>

namespace selene {

double deg_to_rad(double deg) { return deg * (PI / 180.0); }
double rad_to_deg(double rad) { return rad * (180.0 / PI); }

double py_mod(double a, double b) {
    double m = std::fmod(a, b);
    if (m != 0.0) {
        if ((b < 0) != (m < 0)) m += b;
    } else {
        m = std::copysign(0.0, b);
    }
    return m;
}

double wrap_longitude_deg(double value) {
    double out = py_mod(value + 180.0, 360.0) - 180.0;
    // The modulo can return 360.0 for tiny negative inputs due to rounding; fold it back.
    return out >= 180.0 ? out - 360.0 : out;
}

double wrap_azimuth_deg(double value) {
    double out = py_mod(value, 360.0);
    return out >= 360.0 ? out - 360.0 : out;
}

Vec3 normalize(const Vec3& v) {
    for (double c : v)
        if (!std::isfinite(c)) throw std::invalid_argument("vector contains non-finite components");
    double norm = std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (norm < ZERO_NORM_TOL) throw std::invalid_argument("cannot normalize a zero-length vector");
    return {v[0] / norm, v[1] / norm, v[2] / norm};
}

std::pair<double, double> azimuth_elevation_from_enu(const Vec3& enu) {
    auto [e, n, u] = normalize(enu);
    double horizontal = std::hypot(e, n);
    double elevation = rad_to_deg(std::atan2(u, horizontal));
    double azimuth =
        horizontal < ZERO_NORM_TOL ? 0.0 : wrap_azimuth_deg(rad_to_deg(std::atan2(e, n)));
    return {azimuth, elevation};
}

}  // namespace selene
