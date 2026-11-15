// Earth -> Moon transfer and powered descent for the 3D views (POST /trajectory/simulate,
// packages/contracts/schemas/trajectory-simulate-{request,response}.schema.json).
//
// No trajectory maths here: the computation is the team's `vecteur-traj` tool
// (tools/vecteur_traj, CSPICE + least squares), run as a separate process ("complet" phase) in a
// private temporary directory. This file builds its command line, runs it with a time limit and
// converts its CSV/JSON output:
//  * Positions: the tool writes geocentric J2000 km; they are rotated to ECLIPJ2000 (the frame of
//    POST /celestial/*, rotation about +X by the J2000 obliquity 84381.448 arcsec, as defined by
//    SPICE for ECLIPJ2000) and converted to metres.
//  * Times: the tool's UTC strings are passed through with a trailing Z.
//  * Everything the tool states about its own limits (unlimited propellant, spherical ground,
//    demonstration guidance) is copied into warnings; the result is a visualization of that model,
//    not a validated mission design.
#pragma once

#include <array>
#include <filesystem>
#include <string>

#include "models.hpp"

namespace selene {

struct TrajectoryRequest {
    double latitude_deg = 0, longitude_deg = 0;
    double site_altitude_km = 0;  // above the 1737.4 km reference sphere
    std::string departure_utc;    // ISO 8601 ...Z
    double transfer_days = 4.5;   // target transfer duration (tool searches +/- 2 days around it)
};

// Validates against trajectory-simulate-request.schema.json. Throws ValidationError.
TrajectoryRequest parse_trajectory_request(const json& body);
json to_json(const TrajectoryRequest& r);

// Runs `tool` (the vecteur-traj executable) with SELENE_KERNEL_DIR = kernel_dir. Returns the full
// response body: status "computed" (transfer found; descent included), or "no_solution" (the tool
// found no admissible transfer) with the tool's last output lines as the message. Throws
// std::runtime_error when the tool cannot be run, times out or writes unreadable output.
json simulate_trajectory(const TrajectoryRequest& req, const std::filesystem::path& tool,
                         const std::filesystem::path& kernel_dir, int timeout_s = 120);

// J2000 -> ECLIPJ2000 (rotation about +X by the J2000 obliquity), km -> m.
std::array<double, 3> j2000_km_to_eclip_m(double x, double y, double z);

}  // namespace selene
