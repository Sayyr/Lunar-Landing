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

// Local East-North-Up unit vectors of a SPHERICAL body-fixed frame (X lon 0, Z north pole) at
// planetocentric `lat_rad`, east-positive `lon_rad`:
//   east  = (-sin lon, cos lon, 0)
//   north = (-sin lat cos lon, -sin lat sin lon, cos lat)
//   up    = ( cos lat cos lon,  cos lat sin lon, sin lat)
// Deterministic pole convention: the same formulas are used at |lat| = 90 deg, so the basis is the
// limit along the requested meridian `lon_rad` (continuous as lat -> +/-90 at fixed lon). At the
// south pole "north" then points along meridian lon; at the north pole along meridian lon + 180.
struct EnuBasis {
    Vec3 east, north, up;
};
EnuBasis enu_basis(double lat_rad, double lon_rad);
// Components of `v` (body-fixed) in the basis: {e, n, u}.
Vec3 to_enu(const EnuBasis& b, const Vec3& v);

}  // namespace selene
