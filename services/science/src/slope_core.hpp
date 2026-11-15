// Terrain slope / aspect on a spherical polar-stereographic DEM grid.
//
// Header-only so the offline tiler (tools/slope_tiles.cpp), the service slope check (terrain.cpp) and
// the unit tests (tests/slope_tests.cpp) share one implementation. No I/O here.
//
// Conventions (also written to the output manifest):
//  * Image axes: "right" = increasing sample, "up" = decreasing line (map-up as drawn by the web
//    front). Row 0 of a tile is its smallest line.
//  * Map coordinates of a 0-based pixel centre (line, sample), same as tile_polar_dem.py:
//        x = (sample - sample_off) * scale_m,   y = sign_line * (line - line_off) * scale_m
//        rho = hypot(x, y),   lon - lon0 = atan2(x, sign_y * y)
//  * Spherical polar stereographic, true scale at the pole (LDEM label: "true at the pole"):
//        rho = 2 R tan(c / 2), c = colatitude from the projection pole
//        point scale factor k = d rho / (R dc) = sec^2(c / 2) = 2 / (1 + cos c) = 1 + (rho / 2R)^2
//    so the ground distance spanned by one pixel on the reference sphere is scale_m / k. The
//    projection is conformal, hence k is isotropic (same along line and sample).
//    Terrain at height h above the reference sphere is radially projected onto it, so the
//    horizontal distance between neighbouring surface points is scaled by (R + h) / R.
//  * Gradient: Horn (1981) 3x3 finite differences, using the centre pixel's spacing for the whole
//    window (k and h vary by < 1e-5 relative across 3 pixels here).
//  * slope_deg = atan(|grad z|), relative to the local radial vertical (sphere normal), NOT the
//    gravity (geoid) normal.
//  * Aspect = direction of steepest DESCENT (-grad z), as an angle in degrees in [0, 360) measured
//    clockwise from image-up toward image-right ("grid aspect"). Flat pixels (|grad| < flat_tan)
//    have no aspect (NaN / no-data).
//  * Geographic azimuth (clockwise from local north toward local east) of an image direction is
//    obtained by projecting it onto the image-space north and east vectors at that pixel; see
//    geographic_azimuth_deg(). For the validated LDEM_85S_20M signs (sign_y = +1, sign_line = -1)
//    this reduces to  az_geo = (az_grid - lon_east_deg) mod 360.
//    At rho == 0 (the pole itself) longitude, hence north, is undefined: deterministic fallback
//    lon = lon0 (grid-up is "north", i.e. toward the lon0 meridian / body-fixed +X for lon0 = 0).
//    With LINE/SAMPLE_PROJECTION_OFFSET = 7583.5 the pole lies on a pixel corner, so no pixel centre
//    of LDEM_85S_20M is exactly at the pole; geographic aspect is still ill-conditioned (varies
//    quickly with position) within a few pixels of it, grid aspect is not.
//  * No-data: any non-finite input height in the 3x3 window, or a pixel on the grid border (no full
//    window), gives no-data. Never zero.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

namespace selene::slope {

constexpr std::uint16_t NODATA = 65535;
constexpr double PI = 3.14159265358979323846;
constexpr double DEG = 180.0 / PI;
// Fixed global quantisation (header offset 0, step): value v -> v * step degrees, v <= 65534.
constexpr double SLOPE_STEP_DEG = 90.0 / 65534.0;    // ~0.00137 deg
constexpr double ASPECT_STEP_DEG = 360.0 / 65534.0;  // ~0.00549 deg; 360 wraps to 0

struct Projection {
    double radius_m = 1737400.0;  // reference sphere radius (label A_AXIS_RADIUS)
    double line_off = 0.0;        // 0-based pixel coordinate of the projection pole
    double sample_off = 0.0;
    double scale_m = 20.0;  // map pixel size, true at the pole
    int sign_y = 1;         // y = sign_y * rho * cos(lon - lon0)
    int sign_line = -1;     // line = line_off + sign_line * y / scale_m
};

struct MapXY {
    double x, y;
};

inline MapXY map_xy(const Projection& p, double line, double sample) {
    return {(sample - p.sample_off) * p.scale_m, p.sign_line * (line - p.line_off) * p.scale_m};
}

// Polar stereographic point scale factor k at map radius rho (sphere, k = 1 at the pole).
inline double scale_factor(double rho_m, double radius_m) {
    const double t = rho_m / (2.0 * radius_m);
    return 1.0 + t * t;
}

// Ground distance (m) between adjacent pixel centres at this pixel for terrain height h_m above the
// reference sphere.
inline double ground_spacing_m(const Projection& p, double line, double sample, double h_m) {
    const MapXY m = map_xy(p, line, sample);
    return p.scale_m / scale_factor(std::hypot(m.x, m.y), p.radius_m) * (p.radius_m + h_m) / p.radius_m;
}

// Longitude relative to lon0 (radians, in (-pi, pi]); 0 at the pole (deterministic fallback).
inline double relative_lon_rad(const Projection& p, double line, double sample) {
    const MapXY m = map_xy(p, line, sample);
    if (m.x == 0.0 && m.y == 0.0) return 0.0;
    return std::atan2(m.x, p.sign_y * m.y);
}

inline double wrap360(double a) {
    a = std::fmod(a, 360.0);
    if (a < 0) a += 360.0;
    if (a >= 360.0) a -= 360.0;
    return a;
}

// Geographic azimuth (deg, clockwise from local north toward east) of the image direction with grid
// azimuth az_grid_deg (clockwise from image-up), at pixel (line, sample).
inline double geographic_azimuth_deg(const Projection& p, double line, double sample, double az_grid_deg) {
    const double dl = relative_lon_rad(p, line, sample);
    // d(x, y) of increasing colatitude-away-from-pole (= north for a south-polar map) and of
    // increasing longitude, then map (x, y) -> image (right, up): right = x, up = -sign_line * y.
    const double up_per_y = -static_cast<double>(p.sign_line);
    const double n_r = std::sin(dl), n_u = up_per_y * p.sign_y * std::cos(dl);
    const double e_r = std::cos(dl), e_u = -up_per_y * p.sign_y * std::sin(dl);
    const double a = az_grid_deg / DEG;
    const double d_r = std::sin(a), d_u = std::cos(a);
    return wrap360(std::atan2(d_r * e_r + d_u * e_u, d_r * n_r + d_u * n_u) * DEG);
}

struct SlopeAspect {
    double slope_deg;   // NaN = no-data
    double aspect_deg;  // NaN = no-data or flat
};

// Horn gradient at interior pixel (l, s) of a lines x samples grid of heights in km.
inline SlopeAspect horn_at(const float* h_km, int lines, int samples, int l, int s, const Projection& p,
                           double flat_tan) {
    constexpr double nan = std::numeric_limits<double>::quiet_NaN();
    if (l < 1 || s < 1 || l >= lines - 1 || s >= samples - 1) return {nan, nan};
    const float* up = h_km + static_cast<std::size_t>(l - 1) * samples + s;
    const float* mid = up + samples;
    const float* dn = mid + samples;
    const double a = up[-1], b = up[0], c = up[1];
    const double d = mid[-1], e = mid[0], f = mid[1];
    const double g = dn[-1], h = dn[0], i = dn[1];
    if (!(std::isfinite(a) && std::isfinite(b) && std::isfinite(c) && std::isfinite(d) && std::isfinite(e) &&
          std::isfinite(f) && std::isfinite(g) && std::isfinite(h) && std::isfinite(i)))
        return {nan, nan};
    const double sp = ground_spacing_m(p, l, s, e * 1000.0);
    const double k = 1000.0 / (8.0 * sp);  // km -> m, Horn normalisation
    const double gr = ((c + 2 * f + i) - (a + 2 * d + g)) * k;  // dz/d(right)
    const double gu = ((a + 2 * b + c) - (g + 2 * h + i)) * k;  // dz/d(up)
    const double mag = std::hypot(gr, gu);
    const double slope = std::atan(mag) * DEG;
    const double aspect = mag < flat_tan ? nan : wrap360(std::atan2(-gr, -gu) * DEG);
    return {slope, aspect};
}

// Horn slope (deg) on a grid whose ground spacing differs along the two image axes (simple
// cylindrical DEMs: east-west spacing R cos(lat) dlon, north-south spacing R dlat). Spacings are on the
// reference sphere of radius radius_m and are scaled by (R + h) / R with the centre height, as above.
// NaN on the border or with any non-finite height in the 3x3 window. Image "up" = decreasing line.
inline double horn_slope_xy(const float* h_km, int lines, int samples, int l, int s, double sp_right_m,
                            double sp_up_m, double radius_m) {
    constexpr double nan = std::numeric_limits<double>::quiet_NaN();
    if (l < 1 || s < 1 || l >= lines - 1 || s >= samples - 1) return nan;
    const float* up = h_km + static_cast<std::size_t>(l - 1) * samples + s;
    const float* mid = up + samples;
    const float* dn = mid + samples;
    const double a = up[-1], b = up[0], c = up[1];
    const double d = mid[-1], e = mid[0], f = mid[1];
    const double g = dn[-1], h = dn[0], i = dn[1];
    if (!(std::isfinite(a) && std::isfinite(b) && std::isfinite(c) && std::isfinite(d) && std::isfinite(e) &&
          std::isfinite(f) && std::isfinite(g) && std::isfinite(h) && std::isfinite(i)))
        return nan;
    const double hs = (radius_m + e * 1000.0) / radius_m;
    const double gr = ((c + 2 * f + i) - (a + 2 * d + g)) * 1000.0 / (8.0 * sp_right_m * hs);
    const double gu = ((a + 2 * b + c) - (g + 2 * h + i)) * 1000.0 / (8.0 * sp_up_m * hs);
    return std::atan(std::hypot(gr, gu)) * DEG;
}

inline std::uint16_t quantize(double v, double step, double wrap = 0.0) {
    if (!std::isfinite(v)) return NODATA;
    long q = std::lround(v / step);
    if (wrap > 0 && q >= std::lround(wrap / step)) q = 0;
    return static_cast<std::uint16_t>(std::clamp(q, 0L, 65534L));
}

// Full-grid slope/aspect, quantised. aspect_q may be null.
inline void slope_aspect_grid(const float* h_km, int lines, int samples, const Projection& p, double flat_tan,
                              std::uint16_t* slope_q, std::uint16_t* aspect_q) {
#pragma omp parallel for schedule(dynamic, 16)
    for (int l = 0; l < lines; ++l) {
        for (int s = 0; s < samples; ++s) {
            const SlopeAspect r = horn_at(h_km, lines, samples, l, s, p, flat_tan);
            const std::size_t idx = static_cast<std::size_t>(l) * samples + s;
            slope_q[idx] = quantize(r.slope_deg, SLOPE_STEP_DEG);
            if (aspect_q) aspect_q[idx] = quantize(r.aspect_deg, ASPECT_STEP_DEG, 360.0);
        }
    }
}

// b x b block mean (baseline coarsening). Any non-finite child -> NaN. Output floor(n / b).
inline std::vector<float> block_mean(const float* h, int lines, int samples, int b, int& out_lines,
                                     int& out_samples) {
    out_lines = lines / b;
    out_samples = samples / b;
    std::vector<float> out(static_cast<std::size_t>(out_lines) * out_samples);
#pragma omp parallel for schedule(static)
    for (int L = 0; L < out_lines; ++L) {
        for (int S = 0; S < out_samples; ++S) {
            double sum = 0;
            bool ok = true;
            for (int dl = 0; dl < b && ok; ++dl)
                for (int ds = 0; ds < b; ++ds) {
                    const float v = h[static_cast<std::size_t>(L * b + dl) * samples + S * b + ds];
                    if (!std::isfinite(v)) {
                        ok = false;
                        break;
                    }
                    sum += v;
                }
            out[static_cast<std::size_t>(L) * out_samples + S] =
                ok ? static_cast<float>(sum / (b * b)) : std::numeric_limits<float>::quiet_NaN();
        }
    }
    return out;
}

// One pyramid step (x2 coarser, floor(n / 2), same truncation as tile_polar_dem.py):
// slope = MAX of the 2x2 children (conservative for hazard display); any no-data child -> no-data
// (unknown terrain could hide a steeper slope). Aspect = aspect of the child holding that max slope
// (first in raster order on ties); aspect may be null.
inline void max_pool(const std::uint16_t* slope, const std::uint16_t* aspect, int lines, int samples,
                     std::vector<std::uint16_t>& out_slope, std::vector<std::uint16_t>& out_aspect, int& out_lines,
                     int& out_samples) {
    out_lines = lines / 2;
    out_samples = samples / 2;
    const std::size_t n = static_cast<std::size_t>(out_lines) * out_samples;
    out_slope.assign(n, NODATA);
    if (aspect) out_aspect.assign(n, NODATA);
#pragma omp parallel for schedule(static)
    for (int L = 0; L < out_lines; ++L) {
        for (int S = 0; S < out_samples; ++S) {
            std::uint16_t best = 0;
            std::size_t best_idx = 0;
            bool nodata = false, first = true;
            for (int dl = 0; dl < 2; ++dl)
                for (int ds = 0; ds < 2; ++ds) {
                    const std::size_t idx = static_cast<std::size_t>(2 * L + dl) * samples + 2 * S + ds;
                    const std::uint16_t v = slope[idx];
                    if (v == NODATA) nodata = true;
                    else if (first || v > best) {
                        best = v;
                        best_idx = idx;
                        first = false;
                    }
                }
            const std::size_t o = static_cast<std::size_t>(L) * out_samples + S;
            if (nodata) continue;
            out_slope[o] = best;
            if (aspect) out_aspect[o] = aspect[best_idx];
        }
    }
}

}  // namespace selene::slope
