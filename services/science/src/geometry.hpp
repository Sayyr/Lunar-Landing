// Pure geometry helpers.
//
// Conventions (see docs/validation.md):
// - Public JSON uses degrees; internal computations use radians. Convert only at the boundary.
// - Longitude is east-positive, wrapped to [-180, 180).
// - Azimuth is measured from local north toward east, wrapped to [0, 360).
#pragma once

#include <array>
#include <utility>

namespace selene {

// Vectors with a norm below this are treated as zero (direction undefined).
constexpr double ZERO_NORM_TOL = 1e-15;
constexpr double PI = 3.141592653589793238462643383279502884;

double deg_to_rad(double deg);
double rad_to_deg(double rad);

// Floored modulo with NumPy/Python semantics: the result has the sign of `b`.
double py_mod(double a, double b);

// Wrap to [-180, 180). +180 maps to -180.
double wrap_longitude_deg(double value);
// Wrap to [0, 360).
double wrap_azimuth_deg(double value);

using Vec3 = std::array<double, 3>;

// Unit vector. Throws std::invalid_argument for (near-)zero or non-finite vectors.
Vec3 normalize(const Vec3& v);

// {azimuth, elevation} in degrees of a direction expressed in a local East-North-Up frame.
// Building the ENU frame itself (and its polar convention) is the ephemeris provider's job.
// For a direction exactly along Up/Down, azimuth is undefined and returned as 0.0.
std::pair<double, double> azimuth_elevation_from_enu(const Vec3& enu);

}  // namespace selene
