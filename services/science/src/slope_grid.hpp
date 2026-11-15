// Slope statistics on regular grids of fixed-size discs covering a polar-stereographic slope grid
// (offline screening of the whole LDEM_85S_20M area, tools/slope_grid.cpp). Header-only, no I/O,
// so the tool and tests/slope_tests.cpp share it.
//
// Geometry (map = polar stereographic plane of slope_core.hpp, metres):
//  * Grid g places disc centres at map (x, y) = ((i + ox_g) * step, (j + oy_g) * step), i, j integers.
//    Offsets: grid 0 (0, 0), grid 1 (1/2, 1/2), grid 2 (1/2, 0), grid 3 (0, 1/2). With step equal to
//    the disc diameter, grid 0 alone leaves the square-centre holes uncovered; grids 0 + 1 together
//    form a square lattice of pitch step / sqrt 2 whose covering radius is exactly step / 2, i.e. the
//    union of their discs covers the plane.
//  * The map step is a MAP distance. The disc radius is a GROUND distance on the reference sphere:
//    a disc of ground radius r centred at map radius rho has map radius r * k(rho), k = 1 + (rho/2R)^2
//    (conformal, isotropic; k <= 1.0019 at 85 S, so the map/ground difference is <= 0.19 %). Terrain
//    height ((R + h) / R, <= 0.4 %) is ignored for disc membership.
//  * A pixel belongs to a disc when its centre's map distance to the disc centre <= r * k(rho_centre).
//  * Only discs lying entirely inside the declared coverage circle (map radius rho_max) are produced.
//  * Latitude of a map point: colatitude c from the projection pole with rho = 2 R tan(c / 2);
//    south pole projection: lat = -90 + c. Longitude: lon0 + atan2(x, sign_y * y), wrapped to [-180, 180).
#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

#include "slope_core.hpp"

namespace selene::slope {

constexpr std::array<std::array<double, 2>, 4> GRID_OFFSETS{{{0.0, 0.0}, {0.5, 0.5}, {0.5, 0.0}, {0.0, 0.5}}};

struct DiscCentre {
    int grid;
    double x_m, y_m;  // map coordinates
};

// Disc centres of grid g (0..3) whose whole disc (ground radius radius_m) lies within map radius rho_max_m.
inline std::vector<DiscCentre> grid_centres(int g, double step_m, double radius_m, double rho_max_m, double sphere_m) {
    std::vector<DiscCentre> out;
    const auto [ox, oy] = GRID_OFFSETS.at(static_cast<std::size_t>(g));
    const int n = static_cast<int>(std::ceil(rho_max_m / step_m)) + 1;
    for (int j = -n; j <= n; ++j)
        for (int i = -n; i <= n; ++i) {
            const double x = (i + ox) * step_m, y = (j + oy) * step_m;
            const double rho = std::hypot(x, y);
            if (rho + radius_m * scale_factor(rho, sphere_m) <= rho_max_m) out.push_back({g, x, y});
        }
    return out;
}

// Map radius of the colatitude c (radians) from the projection pole.
inline double rho_of_colat(double colat_rad, double sphere_m) { return 2.0 * sphere_m * std::tan(colat_rad / 2.0); }

struct LatLon {
    double lat_deg, lon_deg;
};

// Planetocentric lat/lon of a map point for a SOUTH-polar projection (center_lat = -90).
inline LatLon south_polar_latlon(const Projection& p, double lon0_deg, double x, double y) {
    const double rho = std::hypot(x, y);
    const double colat = 2.0 * std::atan(rho / (2.0 * p.radius_m));
    double lon = (rho == 0.0 ? 0.0 : std::atan2(x, p.sign_y * y)) * DEG + lon0_deg;
    lon = std::fmod(lon + 180.0, 360.0);
    if (lon < 0) lon += 360.0;
    return {-90.0 + colat * DEG, lon - 180.0};
}

struct DiscStats {
    std::uint32_t valid = 0, nodata = 0;
    double max_deg = std::numeric_limits<double>::quiet_NaN();
    double mean_deg = std::numeric_limits<double>::quiet_NaN();
    std::vector<std::uint32_t> hist;  // bin b: slope in [b * bin_deg, (b + 1) * bin_deg); last bin open-ended
};

// Statistics of the slopes (degrees, NaN = no-data; lines x samples, row-major) inside the disc.
inline DiscStats disc_stats(const float* slope_deg, int lines, int samples, const Projection& p, const DiscCentre& c,
                            double radius_m, double bin_deg, int bins) {
    DiscStats s;
    s.hist.assign(static_cast<std::size_t>(bins), 0);
    const double rmap = radius_m * scale_factor(std::hypot(c.x_m, c.y_m), p.radius_m);
    // map -> pixel: sample = sample_off + x / scale, line = line_off + sign_line * y / scale
    const double sc = p.sample_off + c.x_m / p.scale_m, lc = p.line_off + p.sign_line * c.y_m / p.scale_m;
    const double rp = rmap / p.scale_m;
    const int l0 = std::max(0, static_cast<int>(std::floor(lc - rp))), l1 = std::min(lines - 1, static_cast<int>(std::ceil(lc + rp)));
    const int s0 = std::max(0, static_cast<int>(std::floor(sc - rp))), s1 = std::min(samples - 1, static_cast<int>(std::ceil(sc + rp)));
    double sum = 0, mx = -1;
    for (int l = l0; l <= l1; ++l)
        for (int smp = s0; smp <= s1; ++smp) {
            const double dl = l - lc, ds = smp - sc;
            if (dl * dl + ds * ds > rp * rp) continue;
            const float v = slope_deg[static_cast<std::size_t>(l) * samples + smp];
            if (!std::isfinite(v)) {
                ++s.nodata;
                continue;
            }
            ++s.valid;
            sum += v;
            if (v > mx) mx = v;
            const int b = std::min(bins - 1, static_cast<int>(v / bin_deg));
            ++s.hist[static_cast<std::size_t>(b)];
        }
    if (s.valid) {
        s.mean_deg = sum / s.valid;
        s.max_deg = mx;
    }
    return s;
}

}  // namespace selene::slope
