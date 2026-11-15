// Tests of the standalone CSPICE interface (src/spice.hpp), step by step, without HTTP or JSON,
// then of the API adapter SpiceEphemerisProvider. Includes the C++ port of test_spice() from the
// team's test_validation_lunar_mission.py.
//
// Needs CSPICE (build) and the kernels (run): SELENE_KERNEL_DIR, default data/kernels. Exits 77
// (ctest: skipped) without them. Run scripts/setup-spice.sh to install both.
//
// Reference values come from documents, not from this code:
//  * J2000 = 2000-01-01T11:58:55.816 UTC (NAIF "Time" required reading: ET 0 = 12:00:00 TT,
//    TT - UTC = 64.184 s in 2000); leap second inserted at 2016-12-31T23:59:60Z (naif0012.tls);
//    TT - UTC = 69.184 s since 2017-01-01.
//  * MOON_ME_DE440_ME421 vs MOON_PA_DE440: "approximately 0.02886 degrees" (moon_de440_250416.tf).
//  * Team regression values (calcul_positions.py) and JPL Horizons rows are in other tests/files.

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <functional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "app.hpp"
#include "celestial.hpp"
#include "ephemeris.hpp"
#include "geometry.hpp"
#include "lunar_ephemeris.hpp"
#include "models.hpp"
#include "spice.hpp"

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
#define CHECK_THROWS(expr)                  \
    do {                                    \
        bool thrown_ = false;               \
        try {                               \
            (void)(expr);                   \
        } catch (const spice::Error&) {     \
            thrown_ = true;                 \
        }                                   \
        CHECK(thrown_ && "throws spice::Error: " #expr); \
    } while (0)

static double az_diff(double a, double b) { return std::fabs(std::remainder(a - b, 360.0)); }
static double norm(const Vec3& v) { return std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); }
constexpr double C_KM_S = 299792.458;

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
static const char* DATES[] = {"2026-11-14T12:00:00Z", "2026-12-01T12:00:00Z", "2027-05-01T00:00:00Z"};

// ---------- 1. kernels ----------

static void test_load_errors() {
    CHECK(!spice::loaded_kernel_dir());
    CHECK_THROWS(spice::utc_to_et("2026-11-14T12:00:00Z"));  // nothing loaded yet
    CHECK_THROWS(spice::load_kernels("/nonexistent/selene/kernels"));
    const fs::path empty = fs::temp_directory_path() / "selene-spice-tests-empty";
    fs::create_directories(empty);
    CHECK_THROWS(spice::load_kernels(empty));  // missing files
    fs::remove_all(empty);
    CHECK(!spice::loaded_kernel_dir());
}

static void test_load(const fs::path& kdir) {
    const spice::KernelSet set = spice::load_kernels(kdir);
    CHECK(set.files.size() == spice::required_kernels().size());
    CHECK(spice::loaded_kernel_dir() == fs::weakly_canonical(kdir));
    CHECK(spice::load_kernels(kdir / ".").dir == set.dir);  // same directory, other spelling
    if (fs::is_regular_file(kdir / "SHA256SUMS"))
        for (const auto& k : set.files) CHECK(k.sha256 && k.sha256->size() == 64);
    CHECK(spice::load_kernels(kdir).files.size() == set.files.size());  // idempotent
    CHECK(spice::toolkit_version().find("N00") != std::string::npos);

    // A second, different directory is refused (CSPICE state is per process).
    const fs::path other = fs::temp_directory_path() / "selene-spice-tests-other";
    fs::create_directories(other);
    std::error_code ec;
    for (const auto& k : spice::required_kernels()) fs::create_symlink(kdir / k.name, other / k.name, ec);
    if (!ec) CHECK_THROWS(spice::load_kernels(other));
    fs::remove_all(other);
    CHECK(spice::loaded_kernel_dir() == fs::weakly_canonical(kdir));
}

// ---------- 2. time ----------

static void test_time() {
    // ET 0 is J2000 = 2000-01-01T11:58:55.816 UTC (TDB - TT is ~1e-5 s at that epoch).
    CHECK(std::fabs(spice::utc_to_et("2000-01-01T11:58:55.816Z")) < 1e-3);
    // The leap second at the end of 2016: 23:59:59 -> 00:00:00 spans 2 SI seconds.
    CHECK(std::fabs(spice::utc_to_et("2017-01-01T00:00:00Z") - spice::utc_to_et("2016-12-31T23:59:59Z") - 2.0) < 1e-6);
    // Since 2017: ET - (UTC seconds since J2000 noon) = TT - UTC = 69.184 s, up to |TDB - TT| < 2 ms.
    const int64_t t = parse_utc("2026-11-14T12:00:00Z");
    const double utc_s_since_j2000 = static_cast<double>(t - parse_utc("2000-01-01T12:00:00Z")) / 1e6;
    CHECK(std::fabs(spice::utc_to_et(t) - utc_s_since_j2000 - 69.184) < 0.002);
    // Both overloads agree, to the microsecond input.
    const int64_t frac = parse_utc("2026-11-14T12:00:00.123456Z");
    CHECK(std::fabs(spice::utc_to_et(frac) - spice::utc_to_et("2026-11-14T12:00:00.123456Z")) < 1e-7);
    // Round trip ET -> UTC.
    CHECK(spice::et_to_utc(spice::utc_to_et("2026-11-14T12:00:00.123456Z")) == "2026-11-14T12:00:00.123456");
    // Bad input: a clean error, and CSPICE keeps working afterwards.
    CHECK_THROWS(spice::utc_to_et("not a date"));
    CHECK(std::isfinite(spice::utc_to_et(t)));
}

// ---------- 3. frames and constants ----------

static double rotation_angle_deg(const spice::Mat3& r) {
    const double tr = r[0][0] + r[1][1] + r[2][2];
    return rad_to_deg(std::acos(std::min(1.0, std::max(-1.0, (tr - 1.0) / 2.0))));
}

static void check_rotation(const spice::Mat3& r) {
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j) {
            double d = 0;
            for (int k = 0; k < 3; ++k) d += r[i][k] * r[j][k];
            CHECK(std::fabs(d - (i == j ? 1.0 : 0.0)) < 1e-12);
        }
    const double det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) -
                       r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) +
                       r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
    CHECK(std::fabs(det - 1.0) < 1e-12);
}

static void test_frames() {
    for (double r : spice::moon_radii_km()) CHECK(r == 1737.4);
    const double et1 = spice::utc_to_et(DATES[0]), et2 = spice::utc_to_et(DATES[2]);
    const spice::Mat3 me_pa = spice::frame_rotation("MOON_ME", "MOON_PA", et1);
    check_rotation(me_pa);
    const double angle = rotation_angle_deg(me_pa);
    std::printf("MOON_ME -> MOON_PA rotation: %.5f deg (FK: approximately 0.02886 deg)\n", angle);
    CHECK(std::fabs(angle - 0.02886) < 0.0005);
    // Fixed offset (FIXED frame class): the same at another epoch.
    const spice::Mat3 me_pa2 = spice::frame_rotation("MOON_ME", "MOON_PA", et2);
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j) CHECK(std::fabs(me_pa[i][j] - me_pa2[i][j]) < 1e-15);
    check_rotation(spice::frame_rotation("MOON_ME", "J2000", et1));
    CHECK_THROWS(spice::frame_rotation("MOON_ME", "NO_SUCH_FRAME", et1));
}

// ---------- 4. observer ----------

static void test_site_position() {
    for (const TestSite& s : SITES) {
        const Vec3 p = spice::site_position_km(s.lat, s.lon, s.height_km * 1000.0);  // m in, km out
        CHECK(std::fabs(norm(p) - (1737.4 + s.height_km)) < 1e-9);
        CHECK(std::fabs(rad_to_deg(std::asin(p[2] / norm(p))) - s.lat) < 1e-9);
        if (std::fabs(s.lat) < 90) CHECK(az_diff(rad_to_deg(std::atan2(p[1], p[0])), s.lon) < 1e-9);
    }
}

// ---------- 5. apparent Sun/Earth vectors ----------

static void test_apparent_positions() {
    for (const char* date : DATES) {
        const double et = spice::utc_to_et(date);
        const Vec3 obs = spice::site_position_km(-85.0, -30.0, 2.0);
        const spice::Apparent earth = spice::apparent_position("EARTH", et, obs);
        const spice::Apparent sun = spice::apparent_position("SUN", et, obs);
        // Order of magnitude from lunar geometry: Earth-Moon 356 000-407 000 km (+/- R_moon), Sun ~1 au.
        CHECK(norm(earth.position_km) > 350000 && norm(earth.position_km) < 410000);
        CHECK(norm(sun.position_km) > 1.45e8 && norm(sun.position_km) < 1.53e8);
        // CN light time: |apparent position| = c * light time (aberration rotates, keeps length).
        CHECK(std::fabs(norm(earth.position_km) / (C_KM_S * earth.light_time_s) - 1.0) < 1e-9);
        CHECK(std::fabs(norm(sun.position_km) / (C_KM_S * sun.light_time_s) - 1.0) < 1e-9);
    }
    CHECK_THROWS(spice::apparent_position("NO_SUCH_BODY", spice::utc_to_et(DATES[0]), {1737.4, 0, 0}));
    // Outside de440s.bsp (ends 2150-01-22).
    CHECK_THROWS(spice::apparent_position("EARTH", spice::utc_to_et("2200-01-01T00:00:00Z"), {1737.4, 0, 0}));
}

// ---------- 6. az/el: cross-check with CSPICE azlcpo (port of the Python test_spice) ----------

static void test_az_el_cross_check() {
    double max_az = 0, max_el = 0, max_range = 0;
    for (const char* date : DATES) {
        const double et = spice::utc_to_et(date);
        for (const TestSite& s : SITES)
            for (const char* target : {"SUN", "EARTH"}) {
                const spice::AzEl a = spice::az_el(target, et, s.lat, s.lon, s.height_km * 1000.0);
                const spice::AzEl b = spice::az_el_azlcpo(target, et, s.lat, s.lon, s.height_km * 1000.0);
                const double da = az_diff(a.azimuth_deg, b.azimuth_deg), de = std::fabs(a.elevation_deg - b.elevation_deg);
                max_az = std::max(max_az, da);
                max_el = std::max(max_el, de);
                max_range = std::max(max_range, std::fabs(a.range_km - b.range_km));
                std::printf("%.10s | %-16s | %-5s | az=%9.4f el=%9.4f | diff %.2e / %.2e deg\n", date, s.name, target,
                            a.azimuth_deg, a.elevation_deg, da, de);
                CHECK(da < 0.001 && de < 0.001);  // threshold of the Python script (SEUIL_DEGRES)
            }
    }
    std::printf("az_el vs azlcpo: max |d az| = %.3e deg, max |d el| = %.3e deg, max |d range| = %.3e km\n", max_az,
                max_el, max_range);
    CHECK(max_range < 1e-6);
}

static void test_reference_values() {
    // calcul_positions.py, (-85, -30, 1.5 km), 2026-11-14 12:00 UTC; 0.01 deg as the Python check.
    const double et = spice::utc_to_et(DATES[0]);
    const spice::AzEl sun = spice::az_el("SUN", et, -85.0, -30.0, 1500.0);
    const spice::AzEl earth = spice::az_el("EARTH", et, -85.0, -30.0, 1500.0);
    std::printf("reference: Sun az %.4f el %.4f, Earth az %.4f el %.4f\n", sun.azimuth_deg, sun.elevation_deg,
                earth.azimuth_deg, earth.elevation_deg);
    CHECK(az_diff(sun.azimuth_deg, 150.4971) < 0.01 && std::fabs(sun.elevation_deg - -2.7963) < 0.01);
    CHECK(az_diff(earth.azimuth_deg, 28.0084) < 0.01 && std::fabs(earth.elevation_deg - 0.2914) < 0.01);
}

static void test_poles() {
    const double et = spice::utc_to_et(DATES[0]);
    for (double lat : {-90.0, 90.0})
        for (double lon : {0.0, 73.0, -150.0})
            for (const char* target : {"SUN", "EARTH"}) {
                const spice::AzEl pole = spice::az_el(target, et, lat, lon, 2.0);
                const spice::AzEl near = spice::az_el(target, et, lat < 0 ? -89.9999999 : 89.9999999, lon, 2.0);
                CHECK(std::isfinite(pole.azimuth_deg) && pole.azimuth_deg >= 0 && pole.azimuth_deg < 360);
                CHECK(az_diff(pole.azimuth_deg, near.azimuth_deg) < 1e-4);  // continuous along the meridian
                CHECK(std::fabs(pole.elevation_deg - near.elevation_deg) < 1e-4);
            }
    // South pole: north points along the requested meridian, so az + lon is the same for every lon.
    const spice::AzEl a = spice::az_el("SUN", et, -90.0, 0.0, 2.0), b = spice::az_el("SUN", et, -90.0, 73.0, 2.0);
    CHECK(az_diff(a.azimuth_deg, b.azimuth_deg + 73.0) < 1e-9);
    CHECK(std::fabs(a.elevation_deg - b.elevation_deg) < 1e-9);
}

static void test_meeus_vs_spice() {
    // Measured (docs/validation.md), not asserted against the 0.1 deg budget; gross bound only.
    double max_err = 0;
    for (const char* date : DATES) {
        const int64_t t = parse_utc(date);
        const MoonGeometry m = moon_geometry(julian_date_utc(t) + TT_MINUS_UTC_S / 86400.0);
        const double et = spice::utc_to_et(t);
        for (const TestSite& s : SITES) {
            const spice::AzEl e = spice::az_el("EARTH", et, s.lat, s.lon, s.height_km * 1000.0);
            const auto [az, el] =
                azimuth_elevation_from_enu(earth_from_lunar_site_enu_km(m, deg_to_rad(s.lat), deg_to_rad(s.lon), s.height_km));
            const double a1 = deg_to_rad(az), e1 = deg_to_rad(el), a2 = deg_to_rad(e.azimuth_deg), e2 = deg_to_rad(e.elevation_deg);
            const double c = std::sin(e1) * std::sin(e2) + std::cos(e1) * std::cos(e2) * std::cos(a1 - a2);
            max_err = std::max(max_err, rad_to_deg(std::acos(std::min(1.0, std::max(-1.0, c)))));
        }
    }
    std::printf("analytic Earth direction vs SPICE: max angular separation %.4f deg (24 cases)\n", max_err);
    CHECK(max_err < 1.0);
}

static void test_threads() {
    const double et = spice::utc_to_et(DATES[0]);
    const spice::AzEl ref = spice::az_el("SUN", et, -85.0, -30.0, 2.0);
    std::vector<std::thread> pool;
    std::vector<int> same(8, 0);
    for (int i = 0; i < 8; ++i)
        pool.emplace_back([&, i] {
            int ok = 1;
            for (int k = 0; k < 200; ++k) {
                const spice::AzEl a = spice::az_el("SUN", spice::utc_to_et(DATES[0]), -85.0, -30.0, 2.0);
                ok = ok && a.azimuth_deg == ref.azimuth_deg && a.elevation_deg == ref.elevation_deg;
            }
            same[i] = ok;
        });
    for (auto& th : pool) th.join();
    for (int ok : same) CHECK(ok);
}

// ---------- 7. API adapter (SpiceEphemerisProvider through App) ----------

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
    CHECK(r.body["model"]["kernel_set"].size() == spice::required_kernels().size());
    CHECK(r.body["data_provenance"].size() == spice::required_kernels().size());
    for (const auto& p : r.body["data_provenance"]) CHECK(p["kind"] == "spice_kernel");
    CHECK(!r.body["assumptions"].empty());
    // The adapter adds nothing to the numbers: sample 0 equals spice::az_el.
    const double et0 = spice::utc_to_et(req["start_utc"].get<std::string>());
    const spice::AzEl sun0 = spice::az_el("SUN", et0, req["site"]["latitude_deg"], req["site"]["longitude_deg"],
                                          req["site"]["observer_height_m"]);
    CHECK(r.body["samples"][0]["sun"]["azimuth_deg"].get<double>() == sun0.azimuth_deg);
    CHECK(r.body["samples"][0]["sun"]["elevation_deg"].get<double>() == sun0.elevation_deg);
    for (const auto& s : r.body["samples"])
        for (const char* b : {"sun", "earth"}) {
            const double az = s[b]["azimuth_deg"], el = s[b]["elevation_deg"];
            CHECK(std::isfinite(az) && az >= 0 && az < 360 && el >= -90 && el <= 90);
        }

    // Outside de440s.bsp: a clear not_ready, never invented numbers; the service keeps working.
    json late = req;
    late["start_utc"] = "2200-01-01T00:00:00Z";
    auto bad = app.handle("POST", "/evaluate", late.dump());
    CHECK(bad.status == 200 && bad.body["status"] == "not_ready" && bad.body["samples"].empty());
    CHECK(bad.body["message"].get<std::string>().find("SPICE error") != std::string::npos);
    CHECK(app.handle("POST", "/evaluate", req.dump()).body == r.body);

    // Concurrent requests give the same bytes as the serial one.
    const std::string expected = r.body.dump();
    std::vector<std::thread> pool;
    std::vector<int> same(8, 0);
    for (int i = 0; i < 8; ++i)
        pool.emplace_back([&, i] { same[i] = app.handle("POST", "/evaluate", req.dump()).body.dump() == expected; });
    for (auto& th : pool) th.join();
    for (int ok : same) CHECK(ok);
}

// Terrain horizon on the REAL LOLA DEM with real ephemerides. Runs only when SELENE_DEM_PATH points
// at ldem_85s_20m_float.img (920 MB, not in Git, not in CI); otherwise it says so and is skipped.
static void test_real_terrain(const fs::path& kdir) {
    const char* path = std::getenv("SELENE_DEM_PATH");
    if (!path || !*path || !fs::is_regular_file(path)) {
        std::printf("SKIPPED: real-DEM terrain horizon (SELENE_DEM_PATH not set)\n");
        return;
    }
    const auto dem = Dem::open_pds_auto(path, std::nullopt);
    const App app{std::optional<fs::path>(kdir), dem, ""};
    auto evaluate = [&](double lat, double lon, const char* mode) {
        const json req = {{"site", {{"latitude_deg", lat}, {"longitude_deg", lon}, {"observer_height_m", 2.0}}},
                          {"start_utc", "2026-11-15T00:00:00Z"}, {"duration_hours", 720}, {"step_minutes", 60},
                          {"terrain_mode", mode}};
        return app.handle("POST", "/evaluate", req.dump()).body;
    };
    auto hours = [](const json& body, const char* key) {
        double total = 0;
        for (const auto& w : body["windows"][key]) total += static_cast<double>(parse_utc(w["end_utc"]) - parse_utc(w["start_utc"])) / 3.6e9;
        return total;
    };

    // Floor of Shackleton crater (about 89.67 S, 129.8 E): a known permanently shadowed region,
    // ~4 km below its rim. The Sun must never clear the walls; the ideal horizon says "always lit".
    json floor = evaluate(-89.67, 129.8, "dem");
    CHECK(floor["status"] == "computed" && floor["model"]["horizon_model"] == "dem_terrain");
    const json& th = floor["terrain_horizon"];
    CHECK(th["site_surface_height_m"].get<double>() < -2300.0 && th["site_surface_height_m"].get<double>() > -3300.0);
    double lowest = 90.0;
    for (const auto& e : th["elevation_deg"]) lowest = std::min(lowest, e.get<double>());
    CHECK(lowest > 12.0);  // walls all around
    CHECK(floor["windows"]["sun_visible"].empty());
    CHECK(floor["windows"]["earth_visible"].empty());
    CHECK(hours(evaluate(-89.67, 129.8, "ideal"), "sun_visible") > 700.0);
    bool dem_provenance = false;
    for (const auto& p : floor["data_provenance"]) dem_provenance = dem_provenance || p["kind"] == "dem";
    CHECK(dem_provenance && floor["synthetic"] == false);

    // A high point near the Shackleton-de Gerlache ridge (about 89.45 S, 137.3 W): close to 2 km
    // above the sphere, horizon near or below 0 deg, far more sunlight than the crater floor.
    json ridge = evaluate(-89.45, -137.3, "dem");
    CHECK(ridge["status"] == "computed");
    CHECK(ridge["terrain_horizon"]["site_surface_height_m"].get<double>() > 1200.0);
    CHECK(hours(ridge, "sun_visible") > 500.0);

    // Outside the DEM (north of 85 S) and on its edge: not_ready with the reason, no numbers.
    json out = evaluate(-84.0, 0.0, "dem");
    CHECK(out["status"] == "not_ready" && out["samples"].empty());
    json edge = evaluate(-85.2, 45.0, "dem");
    CHECK(edge["status"] == "not_ready");
    CHECK(edge["message"].get<std::string>().find("too close to the edge") != std::string::npos);
    std::printf("real-DEM terrain horizon: Shackleton floor %.0f m, lowest horizon %.1f deg, Sun never visible; "
                "ridge %.0f m, Sun %.0f h of 720\n",
                th["site_surface_height_m"].get<double>(), lowest,
                ridge["terrain_horizon"]["site_surface_height_m"].get<double>(), hours(ridge, "sun_visible"));
}

// Same JSON structure, numbers equal to a relative 1e-9 (fixtures generated on another libm).
static bool near_json(const json& x, const json& y) {
    if (x.is_number() && y.is_number()) {
        const double p = x.get<double>(), q = y.get<double>();
        return std::fabs(p - q) <= std::max(1e-9, 1e-9 * std::max(std::fabs(p), std::fabs(q)));
    }
    if (x.type() != y.type() || x.size() != y.size()) return false;
    if (x.is_object()) {
        for (auto it = x.begin(); it != x.end(); ++it)
            if (!y.contains(it.key()) || !near_json(it.value(), y.at(it.key()))) return false;
        return true;
    }
    if (x.is_array()) {
        for (size_t i = 0; i < x.size(); ++i)
            if (!near_json(x[i], y[i])) return false;
        return true;
    }
    return x == y;
}

// POST /celestial/state: geometric Sun/Earth/Moon state for the 3D views.
static void test_celestial_state(const fs::path& kdir) {
    const App app{std::optional<fs::path>(kdir)};
    auto state = [&](const char* utc) { return app.handle("POST", "/celestial/state", json{{"utc", utc}}.dump()); };
    auto vec = [](const json& j) { return Vec3{j[0].get<double>(), j[1].get<double>(), j[2].get<double>()}; };
    auto mat = [](const json& j) {
        spice::Mat3 m{};
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c) m[r][c] = j[3 * r + c].get<double>();
        return m;
    };

    HttpResponse r = state("2026-11-15T00:00:00Z");
    CHECK(r.status == 200);
    const json& b = r.body;
    CHECK(b["status"] == "computed" && b["synthetic"] == false && b["model"]["provider"] == "spice");
    CHECK(b["model"]["kernel_set"].size() == spice::required_kernels().size());
    CHECK(b["utc"] == "2026-11-15T00:00:00.000Z");

    // Physical ranges: Earth-Moon 356 000-407 000 km, Earth-Sun 147-152.2 million km.
    const Vec3 moon = vec(b["moon_from_earth"]["position_m"]), sun = vec(b["sun_from_earth"]["position_m"]);
    CHECK(norm(moon) > 3.56e8 && norm(moon) < 4.07e8);
    CHECK(norm(sun) > 1.47e11 && norm(sun) < 1.522e11);
    CHECK(std::fabs(b["moon_from_earth"]["distance_m"].get<double>() - norm(moon)) < 1e-3);
    // The Sun stays in the ecliptic plane (|latitude| < 0.01 deg in ECLIPJ2000 near 2026);
    // the Moon within its 5.3 deg orbital inclination; its declination within +-28.7 deg.
    CHECK(std::fabs(b["sun_from_earth"]["latitude_deg"].get<double>()) < 0.01);
    CHECK(std::fabs(b["moon_from_earth"]["latitude_deg"].get<double>()) < 5.4);
    CHECK(std::fabs(b["moon_from_earth"]["declination_deg"].get<double>()) < 28.8);
    // Internal consistency: Sun->Moon = Earth->Moon - Earth->Sun (same geometric epoch).
    const Vec3 ms = vec(b["moon_from_sun"]["position_m"]);
    for (int i = 0; i < 3; ++i) CHECK(std::fabs(ms[i] - (moon[i] - sun[i])) < 1.0);
    // k = (1 + cos i) / 2.
    const double k = (1 + std::cos(deg_to_rad(b["derived"]["phase_angle_deg"].get<double>()))) / 2;
    CHECK(std::fabs(b["derived"]["illuminated_fraction"].get<double>() - k) < 1e-12);

    // Orientation matrices are proper rotations and equal the SPICE frame rotations.
    const double et = spice::utc_to_et(std::string("2026-11-15T00:00:00Z"));
    const spice::Mat3 moon_rot = mat(b["moon_orientation"]), earth_rot = mat(b["earth_orientation"]);
    check_rotation(moon_rot);
    check_rotation(earth_rot);
    const spice::Mat3 ref = spice::frame_rotation("MOON_ME", "ECLIPJ2000", et);
    for (int r2 = 0; r2 < 3; ++r2)
        for (int c = 0; c < 3; ++c) CHECK(std::fabs(moon_rot[r2][c] - ref[r2][c]) < 1e-12);
    // The Moon's +X axis (mean sub-Earth meridian) points at the Earth within the librations (< 8.5 deg).
    const Vec3 x_axis = {moon_rot[0][0], moon_rot[1][0], moon_rot[2][0]};
    const double cos_lib = -(x_axis[0] * moon[0] + x_axis[1] * moon[1] + x_axis[2] * moon[2]) / norm(moon);
    CHECK(rad_to_deg(std::acos(cos_lib)) < 8.5);
    // The Moon's pole stays within ~1.6 deg of the ecliptic pole (inclination 1.54 deg).
    CHECK(rad_to_deg(std::acos(moon_rot[2][2])) < 1.7);
    // The Earth's pole is tilted by the obliquity (23.44 deg) from the ecliptic pole.
    CHECK(std::fabs(rad_to_deg(std::acos(earth_rot[2][2])) - 23.44) < 0.05);

    // Known events (almanac dates, to the minute): full Moon 2026-11-24 14:53 UTC, new Moon
    // 2026-11-09 07:02 UTC. Elongation in ecliptic longitude is 180 / 0 deg at those instants.
    r = state("2026-11-24T14:53:00Z");
    CHECK(r.body["derived"]["phase_name"] == "Full Moon");
    CHECK(r.body["derived"]["illuminated_fraction"].get<double>() > 0.99);
    double d_lon = std::fabs(std::remainder(r.body["moon_from_earth"]["longitude_deg"].get<double>() -
                                            r.body["sun_from_earth"]["longitude_deg"].get<double>() - 180.0, 360.0));
    CHECK(d_lon < 0.05);
    r = state("2026-11-09T07:02:00Z");
    CHECK(r.body["derived"]["phase_name"] == "New Moon");
    CHECK(r.body["derived"]["illuminated_fraction"].get<double>() < 0.01);
    d_lon = std::fabs(std::remainder(r.body["moon_from_earth"]["longitude_deg"].get<double>() -
                                     r.body["sun_from_earth"]["longitude_deg"].get<double>(), 360.0));
    CHECK(d_lon < 0.05);
    // Waxing between new and full, waning after full.
    CHECK(state("2026-11-15T00:00:00Z").body["derived"]["waxing"] == true);
    CHECK(state("2026-11-28T00:00:00Z").body["derived"]["waxing"] == false);

    // Outside the ephemeris: an explicit 503, no positions; the service keeps working.
    r = state("2300-01-01T00:00:00Z");
    CHECK(r.status == 503 && r.body["error"]["code"] == "science_unavailable" && !r.body.contains("moon_from_earth"));
    CHECK(state("2026-11-15T00:00:00Z").status == 200);

    // Live output still matches the generated contract fixture (relative 1e-9: other libm).
    const json fixture = json::parse(std::ifstream(fs::path(SELENE_CONTRACTS_DIR) / "fixtures/celestial-state-response.computed.json"));
    CHECK(near_json(state("2026-11-15T00:00:00Z").body, fixture));
}

// POST /celestial/tracks: orbit traces for the 3D views.
static void test_celestial_tracks(const fs::path& kdir) {
    const App app{std::optional<fs::path>(kdir)};
    auto call = [&](const char* path) { return app.handle("POST", path, json{{"utc", "2026-11-15T00:00:00Z"}}.dump()); };
    auto vec = [](const json& j) { return Vec3{j[0].get<double>(), j[1].get<double>(), j[2].get<double>()}; };
    const HttpResponse r = call("/celestial/tracks");
    CHECK(r.status == 200);
    const json& b = r.body;
    CHECK(b["status"] == "computed" && b["synthetic"] == false && b["model"]["provider"] == "spice");
    const json& moon = b["moon_from_earth"];
    const json& sun = b["sun_from_earth"];
    CHECK(moon["positions_m"].size() == MOON_TRACK_STEPS + 1 && sun["positions_m"].size() == SUN_TRACK_STEPS + 1);
    CHECK(std::fabs(moon["step_hours"].get<double>() - SIDEREAL_MONTH_DAYS * 24 / MOON_TRACK_STEPS) < 1e-12);
    CHECK(moon["start_utc"] == "2026-11-01T08:08:24.201Z");  // utc - 13.660831 d
    // Physical ranges on every sample (same bounds as the state test).
    for (const auto& p : moon["positions_m"]) CHECK(norm(vec(p)) > 3.56e8 && norm(vec(p)) < 4.07e8);
    for (const auto& p : sun["positions_m"]) CHECK(norm(vec(p)) > 1.47e11 && norm(vec(p)) < 1.522e11);
    // The middle sample is the requested instant: equal to /celestial/state there (1 us of rounding: < 1 m).
    const json st = call("/celestial/state").body;
    const Vec3 mid_moon = vec(moon["positions_m"][MOON_TRACK_STEPS / 2]), mid_sun = vec(sun["positions_m"][SUN_TRACK_STEPS / 2]);
    const Vec3 st_moon = vec(st["moon_from_earth"]["position_m"]), st_sun = vec(st["sun_from_earth"]["position_m"]);
    for (int i = 0; i < 3; ++i) CHECK(std::fabs(mid_moon[i] - st_moon[i]) < 1.0 && std::fabs(mid_sun[i] - st_sun[i]) < 50.0);
    // One sidereal month brings the Moon back near its start (< 3 % of the distance: perturbations).
    const Vec3 a = vec(moon["positions_m"].front()), z = vec(moon["positions_m"].back());
    CHECK(norm(Vec3{a[0] - z[0], a[1] - z[1], a[2] - z[2]}) / norm(a) < 0.03);
    // Outside the ephemeris: explicit 503, no positions.
    const HttpResponse out = app.handle("POST", "/celestial/tracks", json{{"utc", "2300-01-01T00:00:00Z"}}.dump());
    CHECK(out.status == 503 && !out.body.contains("moon_from_earth"));
    const json fixture = json::parse(std::ifstream(fs::path(SELENE_CONTRACTS_DIR) / "fixtures/celestial-tracks-response.computed.json"));
    CHECK(near_json(b, fixture));
}

int main() {
    if (!spice::available()) {
        CHECK_THROWS(spice::utc_to_et("2026-11-14T12:00:00Z"));  // the no-CSPICE build fails cleanly
        std::printf("SKIPPED: built without CSPICE (%d checks, %d failures)\n", g_checks, g_failures);
        return g_failures ? 1 : 77;
    }
    const char* env = std::getenv("SELENE_KERNEL_DIR");
    const fs::path kdir = env && *env ? fs::path(env) : fs::path(SELENE_DEFAULT_KERNEL_DIR);
    for (const auto& k : spice::required_kernels())
        if (!fs::is_regular_file(kdir / k.name)) {
            std::printf("SKIPPED: kernel %s not found in %s (run scripts/setup-spice.sh)\n", k.name.c_str(),
                        kdir.string().c_str());
            return 77;
        }

    test_load_errors();
    test_load(kdir);
    test_time();
    test_frames();
    test_site_position();
    test_apparent_positions();
    test_az_el_cross_check();
    test_reference_values();
    test_poles();
    test_meeus_vs_spice();
    test_threads();
    test_api(kdir);
    test_real_terrain(kdir);
    test_celestial_state(kdir);
    test_celestial_tracks(kdir);

    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
