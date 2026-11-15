// SYNTHETIC test DEMs for the slope check (tests/tests.cpp and tools/generate_fixtures.cpp).
// Real lunar sphere (R = 1737.4 km) and LDEM-like projection signs, so zone selection and the
// spacing correction run exactly as on LDEM_85S_20M; only the heights are made up.
#pragma once

#include <cmath>
#include <functional>
#include <vector>

#include "terrain.hpp"

namespace selene::testing {

constexpr int SYN_N = 201;           // lines = samples
constexpr double SYN_POLE = 100.0;   // the pole is the centre of pixel (100, 100)
constexpr double SYN_SCALE_M = 20.0;

inline DemInfo synthetic_info(const std::string& product_id) {
    DemInfo d;
    d.proj.radius_m = 1737400.0;
    d.proj.line_off = SYN_POLE;
    d.proj.sample_off = SYN_POLE;
    d.proj.scale_m = SYN_SCALE_M;
    d.proj.sign_y = 1;
    d.proj.sign_line = -1;
    d.lines = d.samples = SYN_N;
    d.center_lon_deg = 0;
    d.product_id = product_id;
    d.frame = "synthetic (no lunar frame)";
    d.file = "(in memory)";
    d.time_coverage = "n/a";
    d.sha256_note = "synthetic grid, no file";
    d.synthetic = true;
    return d;
}

// Heights in km from z_m(right_m, up_m), map metres from the pole (right = +sample, up = -line).
inline std::shared_ptr<const Dem> synthetic_dem(const std::string& product_id,
                                                const std::function<double(double, double)>& z_m) {
    std::vector<float> h(static_cast<std::size_t>(SYN_N) * SYN_N);
    for (int l = 0; l < SYN_N; ++l)
        for (int s = 0; s < SYN_N; ++s)
            h[static_cast<std::size_t>(l) * SYN_N + s] =
                static_cast<float>(z_m((s - SYN_POLE) * SYN_SCALE_M, -(l - SYN_POLE) * SYN_SCALE_M) / 1000.0);
    return Dem::in_memory(synthetic_info(product_id), std::move(h));
}

// Square SYNTHETIC DEM centred on the south pole, any size: n x n pixels of `scale_m`, heights in
// metres from z_m(right_m, up_m) (right = +sample = lon 90 E, up = -line = lon 0). Used for the
// terrain horizon, which needs tens of kilometres of terrain around the site.
inline std::shared_ptr<const Dem> square_dem(const std::string& product_id, int n, double scale_m,
                                             const std::function<double(double, double)>& z_m) {
    DemInfo d = synthetic_info(product_id);
    d.lines = d.samples = n;
    d.proj.line_off = d.proj.sample_off = (n - 1) / 2.0;
    d.proj.scale_m = scale_m;
    std::vector<float> h(static_cast<std::size_t>(n) * n);
    for (int l = 0; l < n; ++l)
        for (int s = 0; s < n; ++s)
            h[static_cast<std::size_t>(l) * n + s] = static_cast<float>(
                z_m((s - d.proj.sample_off) * scale_m, -(l - d.proj.line_off) * scale_m) / 1000.0);
    return Dem::in_memory(std::move(d), std::move(h));
}

// 120 km square at 100 m with a 1000 m high wall beyond 10 km toward lon 0 (fixture + tests).
inline std::shared_ptr<const Dem> wall_dem() {
    return square_dem("SYNTHETIC_WALL", 1201, 100.0, [](double, double up) { return up >= 10000.0 ? 1000.0 : 0.0; });
}

// Plane rising toward +sample with the given slope (degrees), 0 m at the pole.
inline std::shared_ptr<const Dem> tilted_plane_dem(double slope_deg) {
    const double g = std::tan(slope_deg * 3.14159265358979323846 / 180.0);
    return synthetic_dem("SYNTHETIC_TILTED_PLANE", [g](double right, double) { return g * right; });
}

// Request used for fixtures/slope-check-response.synthetic-dem.json (on tilted_plane_dem(8.0)).
inline json synthetic_fixture_request() {
    return {{"zone", {{"center_latitude_deg", -89.99}, {"center_longitude_deg", 0.0}, {"radius_m", 500}}},
            {"max_slope_deg", 10},
            {"required_fraction", 0.95}};
}

}  // namespace selene::testing
