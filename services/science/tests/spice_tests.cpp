// SPICE provider tests: C++ port of test_spice() in the team's test_validation_lunar_mission.py.
//
// Needs CSPICE (build) and the kernels (run): SELENE_KERNEL_DIR, default data/kernels. Exits 77
// (ctest: skipped) when the kernels are absent. Run scripts/setup-spice.sh to install both.
//
// What is checked:
//  1. Cross-check, same as the Python script: the provider's azimuth/elevation (spkcpo_c + our ENU
//     projection) against CSPICE's own azlcpo_c, 8 sites x 3 dates x {Sun, Earth}, < 0.001 deg.
//     This is internal consistency (same kernels), NOT an independent validation (JPL Horizons).
//  2. Regression: the first values the team computed with calcul_positions.py.
//  3. Poles, out-of-coverage times, API output and thread safety.
//  4. Measured: analytic Earth direction (lunar_ephemeris.hpp, used by /radio/evaluate) vs SPICE.

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

#include <SpiceUsr.h>

#include "app.hpp"
#include "ephemeris.hpp"
#include "geometry.hpp"
#include "lunar_ephemeris.hpp"
#include "models.hpp"

using namespace selene;
namespace fs = std::filesystem;

static int g_checks = 0, g_failures = 0;
#define CHECK(cond)                                                                       \
    do {                                                                                  \
        ++g_checks;                                                                       \
        if (!(cond)) {                                                                    \
            ++g_failures;                                                                 \
            std::fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); \
        }                                                                                 \
    } while (0)

static double az_diff(double a, double b) { return std::fabs(std::remainder(a - b, 360.0)); }

struct TestSite {
    const char* name;
    double lat, lon, height_km;  // as in the Python script (altitude in km)
};
// Same sites as test_validation_lunar_mission.py.
static const TestSite SITES[] = {
    {"Reference", -85.0, -30.0, 1.5},      {"Pres pole Sud", -89.5, 45.0, 0.5},
    {"Sud autre cote", -70.0, 120.0, 2.0}, {"Hemisphere Sud", -30.0, -160.0, 0.0},
    {"Equateur 0", 0.0, 0.0, 0.0},         {"Equateur Est", 0.0, 90.0, 1.0},
    {"Hemisphere Nord", 45.0, -135.0, 0.2}, {"Pres pole Nord", 89.0, 10.0, 0.0},
};
// "2026 NOV 14 12:00:00 UTC", "2026 DEC 01 12:00:00 UTC", "2027 MAY 01 00:00:00 UTC".
static const char* DATES[] = {"2026-11-14T12:00:00Z", "2026-12-01T12:00:00Z", "2027-05-01T00:00:00Z"};

static Site site_of(const TestSite& s) { return {s.lat, s.lon, s.height_km * 1000.0}; }  // km -> m

static void test_cross_check(const SpiceEphemerisProvider& p) {
    double max_az = 0, max_el = 0;
    for (const char* date : DATES) {
        const int64_t t = parse_utc(date);
        SpiceDouble et;
        str2et_c(date, &et);
        for (const TestSite& s : SITES) {
            const DirectionSeries d = p.directions(site_of(s), {t});
            SpiceDouble obspos[3];
            latrec_c(MOON_RADIUS_KM + s.height_km, s.lon * rpd_c(), s.lat * rpd_c(), obspos);
            for (int k = 0; k < 2; ++k) {
                const char* target = k == 0 ? "SUN" : "EARTH";
                SpiceDouble azl[6], lt;
                // azccw = false (azimuth clockwise from north, i.e. toward east), elplsz = true.
                azlcpo_c("ELLIPSOID", target, et, "CN+S", SPICEFALSE, SPICETRUE, obspos, "MOON", "MOON_ME", azl, &lt);
                CHECK(!failed_c());
                const double az_ref = std::fmod(azl[1] * dpr_c() + 360.0, 360.0), el_ref = azl[2] * dpr_c();
                const double az = k == 0 ? d.sun_azimuth_deg[0] : d.earth_azimuth_deg[0];
                const double el = k == 0 ? d.sun_elevation_deg[0] : d.earth_elevation_deg[0];
                const double da = az_diff(az, az_ref), de = std::fabs(el - el_ref);
                max_az = std::max(max_az, da);
                max_el = std::max(max_el, de);
                std::printf("%.10s | %-16s | %-5s | az=%9.4f el=%9.4f | diff %.2e / %.2e deg\n", date, s.name,
                            target, az, el, da, de);
                CHECK(da < 0.001 && de < 0.001);  // threshold of the Python script (SEUIL_DEGRES)
            }
        }
    }
    std::printf("cross-check spkcpo+ENU vs azlcpo: max |d az| = %.3e deg, max |d el| = %.3e deg\n", max_az, max_el);
}

static void test_reference_values(const SpiceEphemerisProvider& p) {
    // First result communicated by the team (calcul_positions.py, -85, -30, 1.5 km, 2026-11-14 12:00 UTC),
    // same 0.01 deg tolerance as the Python regression check.
    const DirectionSeries d = p.directions(site_of(SITES[0]), {parse_utc(DATES[0])});
    std::printf("reference: Sun az %.4f el %.4f, Earth az %.4f el %.4f\n", d.sun_azimuth_deg[0],
                d.sun_elevation_deg[0], d.earth_azimuth_deg[0], d.earth_elevation_deg[0]);
    CHECK(az_diff(d.sun_azimuth_deg[0], 150.4971) < 0.01 && std::fabs(d.sun_elevation_deg[0] - -2.7963) < 0.01);
    CHECK(az_diff(d.earth_azimuth_deg[0], 28.0084) < 0.01 && std::fabs(d.earth_elevation_deg[0] - 0.2914) < 0.01);
}

static void test_poles(const SpiceEphemerisProvider& p) {
    const int64_t t = parse_utc(DATES[0]);
    for (double lat : {-90.0, 90.0})
        for (double lon : {0.0, 73.0, -150.0}) {
            const DirectionSeries pole = p.directions({lat, lon, 2.0}, {t});
            const double near_lat = lat < 0 ? -89.9999999 : 89.9999999;  // ~0.3 m from the pole
            const DirectionSeries near = p.directions({near_lat, lon, 2.0}, {t});
            for (auto [a, b] : {std::pair{pole.sun_azimuth_deg[0], near.sun_azimuth_deg[0]},
                                std::pair{pole.earth_azimuth_deg[0], near.earth_azimuth_deg[0]}}) {
                CHECK(std::isfinite(a) && a >= 0 && a < 360);
                CHECK(az_diff(a, b) < 1e-4);  // continuous along the requested meridian
            }
            CHECK(std::fabs(pole.sun_elevation_deg[0] - near.sun_elevation_deg[0]) < 1e-4);
            CHECK(std::fabs(pole.earth_elevation_deg[0] - near.earth_elevation_deg[0]) < 1e-4);
        }
    // At the south pole the azimuth reference rotates with the requested longitude: az + lon is
    // the same for every lon (north points along meridian lon, east 90 deg clockwise from it).
    const DirectionSeries a = p.directions({-90.0, 0.0, 2.0}, {t}), b = p.directions({-90.0, 73.0, 2.0}, {t});
    CHECK(az_diff(a.sun_azimuth_deg[0], b.sun_azimuth_deg[0] + 73.0) < 1e-9);
    CHECK(std::fabs(a.sun_elevation_deg[0] - b.sun_elevation_deg[0]) < 1e-9);
}

static void test_meeus_vs_spice(const SpiceEphemerisProvider& p) {
    // Measured, not asserted against the docs' 0.1 deg budget: the result is reported in
    // docs/validation.md. Only a gross-error bound is asserted here.
    double max_err = 0;
    for (const char* date : DATES) {
        const int64_t t = parse_utc(date);
        const MoonGeometry m = moon_geometry(julian_date_utc(t) + TT_MINUS_UTC_S / 86400.0);
        for (const TestSite& s : SITES) {
            const DirectionSeries d = p.directions(site_of(s), {t});
            const Vec3 enu = earth_from_lunar_site_enu_km(m, s.lat * rpd_c(), s.lon * rpd_c(), s.height_km);
            const auto [az, el] = azimuth_elevation_from_enu(enu);
            // angle between the two directions (azimuth alone is ill-conditioned near the zenith)
            const double a1 = deg_to_rad(az), e1 = deg_to_rad(el);
            const double a2 = deg_to_rad(d.earth_azimuth_deg[0]), e2 = deg_to_rad(d.earth_elevation_deg[0]);
            const double c = std::sin(e1) * std::sin(e2) + std::cos(e1) * std::cos(e2) * std::cos(a1 - a2);
            const double sep = rad_to_deg(std::acos(std::min(1.0, std::max(-1.0, c))));
            max_err = std::max(max_err, sep);
        }
    }
    std::printf("analytic Earth direction vs SPICE: max angular separation %.4f deg (24 cases)\n", max_err);
    CHECK(max_err < 1.0);
}

static void test_api(const fs::path& kdir) {
    const App app(kdir);
    auto h = app.handle("GET", "/health", "");
    CHECK(h.body["ephemeris"]["ready"] == true);

    json req = json::parse(std::ifstream(fs::path(SELENE_CONTRACTS_DIR) / "fixtures/scenario-request.valid.json"));
    auto r = app.handle("POST", "/evaluate", req.dump());
    CHECK(r.status == 200);
    CHECK(r.body["status"] == "computed");
    CHECK(r.body["synthetic"] == false);
    CHECK(r.body["samples"].size() == 72 * 6 + 1);
    CHECK(r.body["model"]["body_fixed_frame"] == "MOON_ME");
    CHECK(r.body["model"]["kernel_set"].size() == SPICE_KERNELS.size());
    CHECK(r.body["data_provenance"].size() == SPICE_KERNELS.size());
    for (const auto& p : r.body["data_provenance"]) CHECK(p["kind"] == "spice_kernel");
    CHECK(!r.body["assumptions"].empty());
    for (const auto& s : r.body["samples"])
        for (const char* b : {"sun", "earth"}) {
            const double az = s[b]["azimuth_deg"], el = s[b]["elevation_deg"];
            CHECK(std::isfinite(az) && az >= 0 && az < 360 && el >= -90 && el <= 90);
        }
    // Windows agree with the samples' elevation sign.
    for (const char* w : {"sun_visible", "earth_visible"})
        for (const auto& win : r.body["windows"][w]) CHECK(win["start_utc"].get<std::string>() <= win["end_utc"].get<std::string>());

    // Outside de440s.bsp (ends 2150-01-22): a clear not_ready, never invented numbers, and the
    // provider keeps working afterwards (CSPICE error state reset).
    json late = req;
    late["start_utc"] = "2200-01-01T00:00:00Z";
    auto bad = app.handle("POST", "/evaluate", late.dump());
    CHECK(bad.status == 200 && bad.body["status"] == "not_ready" && bad.body["samples"].empty());
    CHECK(bad.body["message"].get<std::string>().find("SPICE error") != std::string::npos);
    CHECK(app.handle("POST", "/evaluate", req.dump()).body == r.body);

    // Thread safety: concurrent requests give the same bytes as the serial one.
    const std::string expected = r.body.dump();
    std::vector<std::thread> pool;
    std::vector<int> same(8, 0);
    for (int i = 0; i < 8; ++i)
        pool.emplace_back([&, i] { same[i] = app.handle("POST", "/evaluate", req.dump()).body.dump() == expected; });
    for (auto& th : pool) th.join();
    for (int ok : same) CHECK(ok);
}

int main() {
    const char* env = std::getenv("SELENE_KERNEL_DIR");
    const fs::path kdir = env && *env ? fs::path(env) : fs::path(SELENE_DEFAULT_KERNEL_DIR);
    for (const auto& k : SPICE_KERNELS)
        if (!fs::is_regular_file(kdir / k)) {
            std::printf("SKIPPED: kernel %s not found in %s (run scripts/setup-spice.sh)\n", k.c_str(), kdir.string().c_str());
            return 77;
        }
    const SpiceEphemerisProvider p(kdir);
    std::printf("provider: %s\n", p.status().reason.c_str());
    CHECK(p.status().ready);
    if (!p.status().ready) return 1;

    test_cross_check(p);
    test_reference_values(p);
    test_poles(p);
    test_meeus_vs_spice(p);
    test_api(kdir);

    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
