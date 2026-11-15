// Standalone CSPICE interface for the science service: kernels, time, lunar frames, Sun/Earth
// geometry, azimuth/elevation. No JSON, no HTTP, no API types: usable and testable on its own
// (tests/spice_tests.cpp). SpiceEphemerisProvider (ephemeris.hpp) is a thin adapter on top.
//
// Conventions (see docs/validation.md):
//  * Time: UTC at this boundary (microseconds since 1970 or ISO 8601 strings); ET = TDB seconds
//    past J2000, converted by CSPICE with the leapseconds kernel.
//  * Body-fixed frame: MOON_ME (moon_de440_250416.tf: MOON_ME_DE440_ME421, the DE421-aligned
//    mean Earth / polar axis frame of the LOLA products). Latitude planetocentric, longitude
//    east-positive.
//  * Observer on the 1737.4 km reference sphere + height. Heights in metres here, converted to
//    kilometres for CSPICE (/ 1000). Distances returned in kilometres (CSPICE units).
//  * Apparent directions: spkcpo_c with CN+S (converged Newtonian light time + stellar aberration).
//  * Azimuth from local north toward east, [0, 360); spherical ENU basis, deterministic at the poles
//    (geometry.hpp enu_basis).
//
// Thread safety: CSPICE keeps global state and is not thread-safe. Every function here takes one
// process-wide lock, so callers may use them from any thread. One kernel directory per process.
// Errors: every CSPICE error (RETURN mode, nothing printed) and every precondition failure is
// thrown as spice::Error; CSPICE's error state is reset before throwing.
// Built without CSPICE (SELENE_HAVE_CSPICE undefined): available() is false and every other
// function throws spice::Error.
#pragma once

#include <array>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "geometry.hpp"

namespace selene::spice {

struct Error : std::runtime_error {
    using std::runtime_error::runtime_error;
};

constexpr const char* FRAME = "MOON_ME";
constexpr const char* ABCORR = "CN+S";
constexpr double MOON_REFERENCE_RADIUS_KM = 1737.4;

// True when this build links CSPICE.
bool available();
// CSPICE toolkit version string (e.g. "CSPICE_N0067"). Throws when !available().
std::string toolkit_version();

struct KernelFile {
    std::string name;       // file name, e.g. "de440s.bsp"
    std::string naif_path;  // path under https://naif.jpl.nasa.gov/pub/naif/generic_kernels/
    std::string notes;      // what it provides, coverage
    std::optional<std::string> sha256;  // from SHA256SUMS next to the file (recorded, not recomputed)
};

// The fixed kernel set (same files as the team's calcul_positions.py), without hashes.
const std::vector<KernelFile>& required_kernels();

struct KernelSet {
    std::filesystem::path dir;  // canonical
    std::vector<KernelFile> files;  // required_kernels() with sha256 filled when recorded
};

// Loads required_kernels() from `dir` (furnsh_c) and checks that the PCK lunar radii equal
// MOON_REFERENCE_RADIUS_KM. Idempotent for the same directory; throws Error for a missing directory
// or file, a CSPICE load error, different radii, or a second, different directory.
KernelSet load_kernels(const std::filesystem::path& dir);
// Directory loaded in this process (canonical path), if any.
std::optional<std::filesystem::path> loaded_kernel_dir();

// ---- time ----
// UTC microseconds since 1970-01-01T00:00:00Z -> ET (TDB seconds past J2000), via str2et_c.
double utc_to_et(int64_t utc_us);
// ISO 8601 UTC string (e.g. "2026-11-14T12:00:00Z"; any format str2et_c accepts) -> ET.
double utc_to_et(const std::string& utc);
// ET -> ISO calendar UTC "YYYY-MM-DDTHH:MM:SS.ffffff" (et2utc_c "ISOC", `digits` decimals).
std::string et_to_utc(double et, int digits = 6);

// ---- frames and body constants ----
using Mat3 = std::array<std::array<double, 3>, 3>;
// Rotation taking vectors from frame `from` to frame `to` at `et` (pxform_c), e.g. MOON_ME -> MOON_PA.
Mat3 frame_rotation(const std::string& from, const std::string& to, double et);
// Moon RADII from the loaded PCK (bodvrd_c), km.
std::array<double, 3> moon_radii_km();

// ---- observer ----
// Site position in MOON_ME, km: planetocentric lat/lon (deg), radius 1737.4 km + height_m / 1000.
// Pure (no kernel needed), but still throws when !available() for a consistent interface.
Vec3 site_position_km(double lat_deg, double lon_deg, double height_m);

// ---- geometry ----
struct Apparent {
    Vec3 position_km;     // target centre relative to the observer, MOON_ME, apparent (CN+S)
    double light_time_s;  // one-way light time
};
// spkcpo_c(target, et, MOON_ME, "OBSERVER", CN+S, observer, "MOON", MOON_ME). `target`: a SPICE
// body name or id, e.g. "SUN", "EARTH".
Apparent apparent_position(const std::string& target, double et, const Vec3& observer_km);

struct AzEl {
    double azimuth_deg;    // from local north toward east, [0, 360); 0 when the target is at zenith/nadir
    double elevation_deg;  // above the ideal geometric horizon of the reference sphere
    double range_km;       // observer to target centre (apparent)
};
// Apparent azimuth/elevation of the target centre seen from a lunar site: apparent_position()
// projected on the spherical ENU basis. This is what the API serves.
AzEl az_el(const std::string& target, double et, double lat_deg, double lon_deg, double height_m);
// Same quantity computed by CSPICE itself (azlcpo_c, "ELLIPSOID", azimuth clockwise, elevation
// positive up). Independent implementation, used to validate az_el(). Undefined at the exact poles.
AzEl az_el_azlcpo(const std::string& target, double et, double lat_deg, double lon_deg, double height_m);

}  // namespace selene::spice
