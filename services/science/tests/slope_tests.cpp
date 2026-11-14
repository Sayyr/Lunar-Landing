// Unit tests for the slope/aspect tiling core (src/slope_core.hpp) on synthetic grids.

#include <cmath>
#include <cstdio>
#include <vector>

#include "slope_core.hpp"

using namespace selene::slope;

static int g_checks = 0, g_failures = 0;
#define CHECK(cond)                                                                       \
    do {                                                                                  \
        ++g_checks;                                                                       \
        if (!(cond)) {                                                                    \
            ++g_failures;                                                                 \
            std::fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); \
        }                                                                                 \
    } while (0)
#define CHECK_NEAR(a, b, tol) CHECK(std::fabs((a) - (b)) <= (tol))

static double ang_diff(double a, double b) {
    double d = std::fmod(std::fabs(a - b), 360.0);
    return d > 180 ? 360 - d : d;
}

// Projection with a huge sphere: k = 1 and (R + h) / R = 1 to < 1e-9, so spacing = scale_m.
static Projection flat_proj(double scale = 20.0) {
    Projection p;
    p.radius_m = 1e15;
    p.line_off = 0;
    p.sample_off = 0;
    p.scale_m = scale;
    return p;
}

// Plane z(m) = z0 + gr * right_m + gu * up_m sampled on an L x S grid of the given ground spacing,
// returned in km. right = +sample, up = -line.
static std::vector<float> plane(int L, int S, double spacing, double gr, double gu, double z0_m = 0) {
    std::vector<float> h(static_cast<std::size_t>(L) * S);
    for (int l = 0; l < L; ++l)
        for (int s = 0; s < S; ++s)
            h[static_cast<std::size_t>(l) * S + s] =
                static_cast<float>((z0_m + gr * s * spacing + gu * (-l) * spacing) / 1000.0);
    return h;
}

static void test_flat() {
    const int N = 7;
    auto h = plane(N, N, 20, 0, 0, 1234.0);
    const Projection p = flat_proj();
    for (int l = 1; l < N - 1; ++l)
        for (int s = 1; s < N - 1; ++s) {
            SlopeAspect r = horn_at(h.data(), N, N, l, s, p, 1e-4);
            CHECK(r.slope_deg == 0.0);
            CHECK(std::isnan(r.aspect_deg));  // flat -> aspect no-data
        }
    std::vector<std::uint16_t> sq(N * N), aq(N * N);
    slope_aspect_grid(h.data(), N, N, p, 1e-4, sq.data(), aq.data());
    CHECK(sq[3 * N + 3] == 0);
    CHECK(aq[3 * N + 3] == NODATA);
    // Borders are no-data, never zero.
    CHECK(sq[0] == NODATA && sq[N - 1] == NODATA && sq[(N - 1) * N] == NODATA && sq[3 * N + 0] == NODATA);
    CHECK(aq[0] == NODATA);
}

static void test_tilted_planes() {
    const int N = 5;
    const Projection p = flat_proj();
    struct Case {
        double gr, gu, aspect;  // aspect = direction of steepest descent, clockwise from image-up
    };
    const Case cases[] = {
        {0, -0.1, 0},                   // descends toward up
        {-0.1, 0, 90},                  // descends toward right
        {0, 0.1, 180},                  // rises toward up -> descends toward down
        {0.1, 0, 270},                  // descends toward left
        {-0.2, -0.2, 45},               // descends toward up-right
        {0.3, 0.3, 225},                // descends toward down-left
        {-std::sqrt(3.0), 1.0, 120},    // |grad| = 2 -> 63.43 deg
        {0.5 * std::sin(330.0 / DEG) * -1, 0.5 * std::cos(330.0 / DEG) * -1, 330},
    };
    for (const Case& c : cases) {
        auto h = plane(N, N, 20, c.gr, c.gu, 500.0);
        SlopeAspect r = horn_at(h.data(), N, N, 2, 2, p, 1e-4);
        const double expect_slope = std::atan(std::hypot(c.gr, c.gu)) * DEG;
        CHECK_NEAR(r.slope_deg, expect_slope, 1e-4);  // float32 km heights: ~1e-5 deg error
        CHECK(ang_diff(r.aspect_deg, c.aspect) < 1e-3);
        if (!(ang_diff(r.aspect_deg, c.aspect) < 1e-3))
            std::fprintf(stderr, "  gr=%g gu=%g: aspect %g expected %g\n", c.gr, c.gu, r.aspect_deg, c.aspect);
    }
    // Known slope values: 45 deg and 30 deg.
    auto h45 = plane(N, N, 20, 1.0, 0, 0);
    CHECK_NEAR(horn_at(h45.data(), N, N, 2, 2, p, 1e-4).slope_deg, 45.0, 1e-4);
    auto h30 = plane(N, N, 20, 0, std::tan(30.0 / DEG), 0);
    CHECK_NEAR(horn_at(h30.data(), N, N, 2, 2, p, 1e-4).slope_deg, 30.0, 1e-4);
    // Quantisation round trip within step / 2.
    std::vector<std::uint16_t> sq(N * N), aq(N * N);
    slope_aspect_grid(h30.data(), N, N, p, 1e-4, sq.data(), aq.data());
    CHECK_NEAR(sq[2 * N + 2] * SLOPE_STEP_DEG, 30.0, SLOPE_STEP_DEG / 2 + 1e-4);
    CHECK_NEAR(aq[2 * N + 2] * ASPECT_STEP_DEG, 180.0, ASPECT_STEP_DEG / 2 + 1e-3);
    // Aspect just below 360 wraps to 0 rather than overflowing into 65535 (no-data).
    CHECK(quantize(359.9999, ASPECT_STEP_DEG, 360.0) == 0);
    CHECK(quantize(std::nan(""), SLOPE_STEP_DEG) == NODATA);
}

// Pixel spacing correction: a pixel at map radius rho with k = 1 + (rho / 2R)^2 = 1.5 spans only
// scale / 1.5 metres of ground; a plane of ground gradient 0.2 must still read atan(0.2).
static void test_scale_factor() {
    const double R = 1737400.0;
    CHECK_NEAR(scale_factor(0, R), 1.0, 1e-15);
    // k = 2 / (1 + cos c) with rho = 2 R tan(c / 2): check at c = 5 deg (85 S).
    const double c = 5.0 / DEG;
    CHECK_NEAR(scale_factor(2 * R * std::tan(c / 2), R), 2 / (1 + std::cos(c)), 1e-12);
    CHECK_NEAR(scale_factor(2 * R * std::tan(c / 2), R), 1.0019, 1e-4);

    Projection p;
    p.radius_m = R;
    p.scale_m = 20;
    const int N = 5;
    const double rho = 2 * R * std::sqrt(0.5);  // k = 1.5
    p.line_off = 2;                              // centre pixel (2, 2) at map (x = rho, y = 0)
    p.sample_off = 2 - rho / p.scale_m;
    CHECK_NEAR(ground_spacing_m(p, 2, 2, 0.0), 20.0 / 1.5, 1e-9);
    CHECK_NEAR(ground_spacing_m(p, 2, 2, R), 2 * 20.0 / 1.5, 1e-9);  // (R + h) / R factor
    auto h = plane(N, N, 20.0 / 1.5, 0.2, 0, 0);
    CHECK_NEAR(horn_at(h.data(), N, N, 2, 2, p, 1e-4).slope_deg, std::atan(0.2) * DEG, 1e-4);
    // Without the correction the slope would read atan(0.2 / 1.5) — make sure that differs.
    CHECK(std::fabs(std::atan(0.2) - std::atan(0.2 / 1.5)) * DEG > 3);
}

static void test_nodata() {
    const int N = 7;
    auto h = plane(N, N, 20, 0.1, 0.05, 0);
    h[3 * N + 3] = std::nanf("");
    const Projection p = flat_proj();
    std::vector<std::uint16_t> sq(N * N), aq(N * N);
    slope_aspect_grid(h.data(), N, N, p, 1e-4, sq.data(), aq.data());
    for (int l = 1; l < N - 1; ++l)
        for (int s = 1; s < N - 1; ++s) {
            const bool touches = std::abs(l - 3) <= 1 && std::abs(s - 3) <= 1;
            CHECK((sq[l * N + s] == NODATA) == touches);
            CHECK((aq[l * N + s] == NODATA) == touches);
        }
    // Block mean (baseline coarsening) propagates no-data.
    int ol, os;
    auto m = block_mean(h.data(), N, N, 3, ol, os);
    CHECK(ol == 2 && os == 2);
    CHECK(std::isnan(m[1 * 2 + 1]));  // block lines 3..5, samples 3..5 contains (3, 3)
    CHECK(std::isfinite(m[0]));
    CHECK_NEAR(m[0], (h[0] + h[1] + h[2] + h[7] + h[8] + h[9] + h[14] + h[15] + h[16]) / 9.0, 1e-6);
}

static void test_max_pool() {
    // 4 x 5 grid -> 2 x 2 (odd sample dropped, as tile_polar_dem.py truncates).
    const std::uint16_t S[] = {1, 9, 3, 4, 77,  //
                               5, 2, 3, 8, 77,  //
                               7, 7, 0, 0, 77,  //
                               NODATA, 1, 0, 0, 77};
    const std::uint16_t A[] = {10, 90, 30, 40, 0,  //
                               50, 20, 31, 80, 0,  //
                               70, 71, NODATA, 1, 0,  //
                               NODATA, 11, 2, 3, 0};
    std::vector<std::uint16_t> os, oa;
    int ol, osm;
    max_pool(S, A, 4, 5, os, oa, ol, osm);
    CHECK(ol == 2 && osm == 2);
    CHECK(os[0] == 9 && oa[0] == 90);    // max child and its aspect
    CHECK(os[1] == 8 && oa[1] == 80);
    CHECK(os[2] == NODATA && oa[2] == NODATA);  // a no-data child -> no-data (conservative)
    CHECK(os[3] == 0 && oa[3] == NODATA);       // all flat: first child (aspect no-data) kept
}

static void test_geographic_azimuth() {
    // Validated LDEM_85S_20M signs: sign_y = +1, sign_line = -1. Pole at pixel (100, 100).
    Projection p;
    p.line_off = 100;
    p.sample_off = 100;
    p.scale_m = 20;
    // Pixel straight image-up from the pole: lon = 0, grid north = image-up.
    CHECK_NEAR(relative_lon_rad(p, 90, 100) * DEG, 0.0, 1e-12);
    CHECK(ang_diff(geographic_azimuth_deg(p, 90, 100, 0), 0) < 1e-9);
    CHECK(ang_diff(geographic_azimuth_deg(p, 90, 100, 90), 90) < 1e-9);
    // Pixel to the image-right of the pole: lon = +90 E; image-up there is local west (270),
    // and pointing toward the pole (image-left, 270) is due south (180).
    CHECK_NEAR(relative_lon_rad(p, 100, 110) * DEG, 90.0, 1e-12);
    CHECK(ang_diff(geographic_azimuth_deg(p, 100, 110, 270), 180) < 1e-9);
    CHECK(ang_diff(geographic_azimuth_deg(p, 100, 110, 0), 270) < 1e-9);
    // Pixel image-down from the pole: lon = 180; pointing image-up (toward the pole) is south.
    CHECK_NEAR(std::fabs(relative_lon_rad(p, 110, 100) * DEG), 180.0, 1e-12);
    CHECK(ang_diff(geographic_azimuth_deg(p, 110, 100, 0), 180) < 1e-9);
    // General rule for these signs: az_geo = az_grid - lon.
    for (double lon : {-135.0, -30.0, 10.0, 75.0, 160.0})
        for (double az : {0.0, 45.0, 200.0, 359.0}) {
            const double l = 100 - 50 * std::cos(lon / DEG), s = 100 + 50 * std::sin(lon / DEG);
            CHECK(ang_diff(geographic_azimuth_deg(p, l, s, az), wrap360(az - lon)) < 1e-9);
        }
    // Exactly at the pole: deterministic fallback lon = 0 (geo = grid).
    CHECK(relative_lon_rad(p, 100, 100) == 0.0);
    CHECK(ang_diff(geographic_azimuth_deg(p, 100, 100, 123), 123) < 1e-12);
}

int main() {
    test_flat();
    test_tilted_planes();
    test_scale_factor();
    test_nodata();
    test_max_pool();
    test_geographic_azimuth();
    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
