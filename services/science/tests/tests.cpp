// Unit, API and contract tests for the science service. Run via `ctest` or directly.
// Ported from the former Python test suite (services/sciencepy/tests).

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <string>
#include <vector>

#include "app.hpp"
#include "dem_label.hpp"
#include "evaluate.hpp"
#include "geometry.hpp"
#include "horizon.hpp"
#include "intervals.hpp"
#include "link.hpp"
#include "lunar_ephemeris.hpp"
#include "models.hpp"
#include "synthetic_dem.hpp"
#include "terrain.hpp"

using namespace selene;
namespace fs = std::filesystem;

static int g_checks = 0, g_failures = 0;

#define CHECK(cond)                                                                   \
    do {                                                                              \
        ++g_checks;                                                                   \
        if (!(cond)) {                                                                \
            ++g_failures;                                                             \
            std::fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); \
        }                                                                             \
    } while (0)
#define CHECK_NEAR(a, b, tol) CHECK(std::fabs((a) - (b)) <= (tol))
#define CHECK_THROWS(expr, Ex)          \
    do {                                \
        bool thrown_ = false;           \
        try {                           \
            (void)(expr);               \
        } catch (const Ex&) {           \
            thrown_ = true;             \
        }                               \
        CHECK(thrown_ && #expr " throws " #Ex); \
    } while (0)

static const fs::path CONTRACTS = SELENE_CONTRACTS_DIR;

static json load(const fs::path& p) {
    std::ifstream f(p);
    return json::parse(f);
}

static const App app(std::nullopt);

static HttpResponse post(const std::string& path, const json& body) {
    return app.handle("POST", path, body.dump());
}

// Structural JSON equality with a numeric tolerance (libm sin() may differ in the last ulp).
static bool json_near(const json& a, const json& b, double tol = 1e-9) {
    if (a.is_number() && b.is_number()) return std::fabs(a.get<double>() - b.get<double>()) <= tol;
    if (a.type() != b.type() || a.size() != b.size()) return false;
    if (a.is_object()) {
        for (auto it = a.begin(); it != a.end(); ++it)
            if (!b.contains(it.key()) || !json_near(it.value(), b.at(it.key()), tol)) return false;
        return true;
    }
    if (a.is_array()) {
        for (size_t i = 0; i < a.size(); ++i)
            if (!json_near(a[i], b[i], tol)) return false;
        return true;
    }
    return a == b;
}

// ---------- geometry ----------

static void test_geometry() {
    CHECK_NEAR(deg_to_rad(180.0), PI, 1e-15);
    CHECK_NEAR(rad_to_deg(PI / 2), 90.0, 1e-12);
    for (double x : {-90.0, 0.0, 45.0, 359.0}) CHECK_NEAR(rad_to_deg(deg_to_rad(x)), x, 1e-12);

    const std::vector<std::pair<double, double>> lon = {
        {0, 0},       {179.999, 179.999}, {180, -180},       {-180, -180}, {190, -170},
        {-190, 170}, {540, -180},        {-1e-17, -1e-17}, {720.5, 0.5}};
    for (auto [raw, wrapped] : lon) {
        double out = wrap_longitude_deg(raw);
        CHECK(out >= -180 && out < 180);
        CHECK_NEAR(out, wrapped, 1e-12);
    }
    const std::vector<std::pair<double, double>> az = {{0, 0},     {360, 0},       {-90, 270},
                                                       {725, 5},   {359.5, 359.5}, {-1e-17, 0}};
    for (auto [raw, wrapped] : az) {
        double out = wrap_azimuth_deg(raw);
        CHECK(out >= 0 && out < 360);
        CHECK_NEAR(out, wrapped, 1e-12);
    }

    Vec3 n = normalize({3.0, 0.0, 4.0});
    CHECK_NEAR(n[0], 0.6, 1e-15);
    CHECK_NEAR(n[1], 0.0, 1e-15);
    CHECK_NEAR(n[2], 0.8, 1e-15);
    Vec3 s = normalize({1e-10, 2e-10, -3e-10});
    CHECK_NEAR(std::sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]), 1.0, 1e-12);
    CHECK_THROWS(normalize({0.0, 0.0, 0.0}), std::invalid_argument);
    CHECK_THROWS(normalize({NAN, 1.0, 0.0}), std::invalid_argument);
    CHECK_THROWS(normalize({INFINITY, 0.0, 0.0}), std::invalid_argument);

    struct Case {
        Vec3 enu;
        double az, el;
    };
    const std::vector<Case> cases = {
        {{0, 1, 0}, 0.0, 0.0},    {{1, 0, 0}, 90.0, 0.0},  {{0, -1, 0}, 180.0, 0.0},
        {{-1, 0, 0}, 270.0, 0.0}, {{0, 1, 1}, 0.0, 45.0},  {{1, 0, -1}, 90.0, -45.0},
        {{0, 0, 1}, 0.0, 90.0},  // zenith: azimuth undefined -> 0 by convention
        {{0, 0, -1}, 0.0, -90.0},
    };
    for (const auto& c : cases) {
        auto [got_az, got_el] = azimuth_elevation_from_enu(c.enu);
        CHECK_NEAR(got_az, c.az, 1e-12);
        CHECK_NEAR(got_el, c.el, 1e-12);
    }
}

// ---------- intervals ----------

// ENU basis: port of test_maths() in the team's test_validation_lunar_mission.py (same sites),
// plus the exact poles, which that script refused.
static void test_enu_basis() {
    struct S { double lat, lon; };
    const S sites[] = {{-85.0, -30.0}, {-89.5, 45.0}, {-70.0, 120.0}, {-30.0, -160.0}, {0.0, 0.0},
                       {0.0, 90.0},    {45.0, -135.0}, {89.0, 10.0},  {-90.0, 0.0},    {-90.0, 73.0},
                       {90.0, -120.0}};
    auto dot = [](const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
    auto cross = [](const Vec3& a, const Vec3& b) {
        return Vec3{a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
    };
    auto lin = [](double a, const Vec3& u, double b, const Vec3& v) {
        return Vec3{a * u[0] + b * v[0], a * u[1] + b * v[1], a * u[2] + b * v[2]};
    };
    for (const S& st : sites) {
        const EnuBasis b = enu_basis(deg_to_rad(st.lat), deg_to_rad(st.lon));
        // orthonormal and right-handed (east x north = up, i.e. det = +1)
        CHECK_NEAR(dot(b.east, b.east), 1.0, 1e-12);
        CHECK_NEAR(dot(b.north, b.north), 1.0, 1e-12);
        CHECK_NEAR(dot(b.up, b.up), 1.0, 1e-12);
        CHECK_NEAR(dot(b.east, b.north), 0.0, 1e-12);
        CHECK_NEAR(dot(b.east, b.up), 0.0, 1e-12);
        CHECK_NEAR(dot(b.north, b.up), 0.0, 1e-12);
        const Vec3 en = cross(b.east, b.north);
        CHECK_NEAR(dot(en, b.up), 1.0, 1e-12);
        // up is the radial direction
        const double la = deg_to_rad(st.lat), lo = deg_to_rad(st.lon);
        const Vec3 u = {std::cos(la) * std::cos(lo), std::cos(la) * std::sin(lo), std::sin(la)};
        CHECK_NEAR(dot(u, b.up), 1.0, 1e-12);

        const double r2 = 1.0 / std::sqrt(2.0);
        struct Case { Vec3 v; double az, el; };
        const Case cases[] = {
            {b.north, 0, 0}, {b.east, 90, 0}, {lin(-1, b.north, 0, b.east), 180, 0},
            {lin(-1, b.east, 0, b.north), 270, 0}, {lin(r2, b.east, r2, b.up), 90, 45},
            {lin(r2, b.north, r2, b.east), 45, 0}, {lin(r2, b.north, r2, b.up), 0, 45},
        };
        for (const Case& c : cases) {
            auto [az, el] = azimuth_elevation_from_enu(to_enu(b, c.v));
            CHECK(std::fabs(std::remainder(az - c.az, 360.0)) < 1e-9);
            CHECK_NEAR(el, c.el, 1e-9);
        }
        auto [az_z, el_z] = azimuth_elevation_from_enu(to_enu(b, b.up));
        CHECK(az_z == 0.0);  // zenith: azimuth undefined, reported as 0
        CHECK_NEAR(el_z, 90.0, 1e-9);
    }
    // Pole convention: at the south pole north points along the requested meridian (toward +X for
    // lon 0); continuous with lat -> -90 at the same longitude.
    const EnuBasis sp = enu_basis(deg_to_rad(-90.0), 0.0);
    CHECK_NEAR(sp.north[0], 1.0, 1e-12);
    const EnuBasis near = enu_basis(deg_to_rad(-89.999999), 0.0);
    CHECK_NEAR(dot(sp.north, near.north), 1.0, 1e-12);
    CHECK_NEAR(dot(sp.east, near.east), 1.0, 1e-12);
}

static void test_intervals() {
    CHECK(extract_intervals({}, {}).empty());
    CHECK(extract_intervals({0, 1, 2}, {-1, -2, -0.5}).empty());
    CHECK((extract_intervals({0, 1, 2}, {1, 2, 3}) == std::vector<Interval>{{0, 2, true, true}}));

    // up-crossing between t=1 (-1) and t=2 (+1) -> 1.5; down between t=3 (+1) and t=4 (-3) -> 3.25
    auto out = extract_intervals({0, 1, 2, 3, 4}, {-2, -1, 1, 1, -3});
    CHECK(out.size() == 1);
    CHECK_NEAR(out[0].start, 1.5, 1e-12);
    CHECK_NEAR(out[0].end, 3.25, 1e-12);
    CHECK(!out[0].clipped_start && !out[0].clipped_end);

    out = extract_intervals({0, 1, 2, 3, 4, 5}, {1, -1, 1, -1, -1, 1});
    CHECK(out.size() == 3);
    CHECK(out[0].clipped_start && !out[0].clipped_end);
    CHECK(!out[1].clipped_start && !out[1].clipped_end);
    CHECK(!out[2].clipped_start && out[2].clipped_end);
    CHECK(out[0].start == 0 && out[2].end == 5);

    // value == threshold is "not above"
    CHECK(extract_intervals({0, 1, 2}, {0, 0, 0}).empty());
    out = extract_intervals({0, 10}, {1, 3}, 2);
    CHECK_NEAR(out[0].start, 5.0, 1e-12);
    CHECK(out[0].clipped_end);

    // sin(t + 0.3) > 0 for t in (0, pi - 0.3) and (2pi - 0.3, 2pi]
    std::vector<double> t, v;
    for (int i = 0; i <= 2000; ++i) {
        t.push_back(2 * PI * i / 2000);
        v.push_back(std::sin(t.back() + 0.3));
    }
    out = extract_intervals(t, v);
    CHECK_NEAR(out[0].end, PI - 0.3, 1e-5);
    CHECK_NEAR(out[1].start, 2 * PI - 0.3, 1e-5);

    CHECK_THROWS(extract_intervals({0, 0, 1}, {1, 2, 3}), std::invalid_argument);
    CHECK_THROWS(extract_intervals({0, 2, 1}, {1, 2, 3}), std::invalid_argument);
    CHECK_THROWS(extract_intervals({0, 1}, {1}), std::invalid_argument);
    CHECK_THROWS(extract_intervals({0, 1}, {NAN, 1}), std::invalid_argument);
}

// ---------- time ----------

// ---------- radio link (engineering tier) ----------

// Fixture comparison that survives a change of platform libm: numbers within 1e-8 relative or
// 1e-6 absolute (ranges are ~4e8 m and range rates come from a difference of two of them, so
// bit-identical sin/cos cannot be demanded), UTC timestamps within 1 ms (an interpolated window
// edge can round to the neighbouring millisecond). Prints the first mismatch for CI logs.
static bool radio_near(const json& a, const json& b, const std::string& path = "") {
    auto fail = [&]() {
        std::fprintf(stderr, "radio fixture mismatch at %s: live %s vs fixture %s\n", path.empty() ? "<root>" : path.c_str(),
                     a.dump().substr(0, 80).c_str(), b.dump().substr(0, 80).c_str());
        return false;
    };
    if (a.is_number() && b.is_number()) {
        const double x = a.get<double>(), y = b.get<double>();
        return std::fabs(x - y) <= std::max(1e-6, 1e-8 * std::max(std::fabs(x), std::fabs(y))) || fail();
    }
    if (a.is_string() && b.is_string() && a != b) {
        try {
            return std::llabs(parse_utc(a.get<std::string>()) - parse_utc(b.get<std::string>())) <= 1000 || fail();
        } catch (const std::invalid_argument&) {
            return fail();
        }
    }
    if (a.type() != b.type() || a.size() != b.size()) return fail();
    if (a.is_object()) {
        for (auto it = a.begin(); it != a.end(); ++it)
            if (!b.contains(it.key()) || !radio_near(it.value(), b.at(it.key()), path + "." + it.key())) return false;
        return true;
    }
    if (a.is_array()) {
        for (size_t i = 0; i < a.size(); ++i)
            if (!radio_near(a[i], b[i], path + "[" + std::to_string(i) + "]")) return false;
        return true;
    }
    return a == b || fail();
}

static void test_link() {
    // The parameter values below are arbitrary test inputs, not a real radio system.
    // FSPL against the independent engineering form 32.44778 + 20log10(d_km) + 20log10(f_MHz).
    const double d = 384400e3, f = 2.2e9;
    CHECK_NEAR(fspl_db(d, f), 32.44778 + 20 * std::log10(384400.0) + 20 * std::log10(2200.0), 1e-4);
    // Inverse-square law: doubling range or frequency costs 20log10(2) dB.
    CHECK_NEAR(fspl_db(2 * d, f) - fspl_db(d, f), 20 * std::log10(2.0), 1e-9);
    CHECK_NEAR(fspl_db(d, 2 * f) - fspl_db(d, f), 20 * std::log10(2.0), 1e-9);
    // At range = wavelength / (4 pi) the loss is 0 dB by definition.
    CHECK_NEAR(fspl_db(SPEED_OF_LIGHT_M_S / (4 * PI * f), f), 0.0, 1e-9);

    const LinkParams p{f, 10.0, 20.0, 2.0, 1000.0, 3.0};
    // 10log10(k_B) = -228.5992 dBW/K/Hz.
    CHECK_NEAR(cn0_dbhz(p, d), 10.0 + 20.0 - fspl_db(d, f) - 2.0 + 228.5992, 1e-4);
    CHECK_NEAR(ebn0_db(p, d), cn0_dbhz(p, d) - 30.0, 1e-9);
    CHECK_NEAR(link_margin_db(p, d), ebn0_db(p, d) - 3.0, 1e-12);
    // Margin moves dB-for-dB with EIRP and falls with range.
    LinkParams q = p;
    q.eirp_dbw += 5.0;
    CHECK_NEAR(link_margin_db(q, d) - link_margin_db(p, d), 5.0, 1e-9);
    CHECK(link_margin_db(p, 1.1 * d) < link_margin_db(p, d));

    // Doppler: receding (range rate > 0) lowers the received frequency.
    CHECK_NEAR(doppler_shift_hz(SPEED_OF_LIGHT_M_S * 1e-6, 1e9), -1000.0, 1e-9);
    CHECK(doppler_shift_hz(-100.0, f) > 0.0);
    CHECK(doppler_shift_hz(0.0, f) == 0.0);

    CHECK_THROWS(fspl_db(0.0, f), std::invalid_argument);
    CHECK_THROWS(fspl_db(d, -1.0), std::invalid_argument);
    CHECK_THROWS(fspl_db(std::nan(""), f), std::invalid_argument);
    LinkParams bad = p;
    bad.data_rate_bps = 0.0;
    CHECK_THROWS(ebn0_db(bad, d), std::invalid_argument);
    bad = p;
    bad.other_losses_db = -1.0;
    CHECK_THROWS(cn0_dbhz(bad, d), std::invalid_argument);
}

static void test_lunar_ephemeris() {
    // Meeus, Astronomical Algorithms, example 47.a: 1992 April 12, 0h TD (JDE 2448724.5):
    // lambda = 133.162655 deg, beta = -3.229126 deg, distance = 368409.7 km (full series).
    // Tolerances cover the truncation of the series used here.
    const MoonGeometry g = moon_geometry(2448724.5);
    CHECK_NEAR(rad_to_deg(g.longitude_rad), 133.162655, 0.01);
    CHECK_NEAR(rad_to_deg(g.latitude_rad), -3.229126, 0.01);
    CHECK_NEAR(g.distance_km, 368409.7, 60.0);
    // Example 53.a, same instant: optical librations l' = -1.206 deg, b' = +4.194 deg.
    CHECK_NEAR(rad_to_deg(g.sub_earth_longitude_rad), -1.206, 0.02);
    CHECK_NEAR(rad_to_deg(g.sub_earth_latitude_rad), 4.194, 0.02);

    // Example 12.a: 1987 April 10, 0h UT (JD 2446895.5): GMST = 13h10m46.3668s = 197.693195 deg.
    // A unit "Moon" on the equinox (RA 0) then sits at Earth-fixed longitude -GMST.
    const Vec3 v = moon_earth_fixed_km(MoonGeometry{0, 0, 1, 0, 0}, 2446895.5);
    CHECK_NEAR(wrap_azimuth_deg(rad_to_deg(std::atan2(v[1], v[0]))), 360.0 - 197.693195, 1e-5);
    CHECK_NEAR(v[2], 0.0, 1e-12);

    // Unix epoch is JD 2440587.5; J2000.0 (2000-01-01T12:00:00 TT) is JD 2451545.0.
    CHECK(julian_date_utc(0) == 2440587.5);
    CHECK_NEAR(julian_date_utc(parse_utc("2000-01-01T12:00:00Z")), 2451545.0, 1e-9);

    // Known ranges over two years: librations stay within ~8 deg (longitude) and ~7 deg
    // (latitude), distance within the perigee/apogee extremes.
    for (double jd = 2461000.5; jd < 2461000.5 + 730; jd += 0.37) {
        const MoonGeometry q = moon_geometry(jd);
        CHECK(std::fabs(rad_to_deg(q.sub_earth_longitude_rad)) < 8.2);
        CHECK(std::fabs(rad_to_deg(q.sub_earth_latitude_rad)) < 7.0);
        CHECK(q.distance_km > 356000.0 && q.distance_km < 407000.0);
    }

    // Site geometry. With the sub-Earth point at (0, 0): from (0, 0) the Earth is at the zenith,
    // from the east limb (0, 90E) it is on the western horizon, from the far side it is at nadir.
    const MoonGeometry z{0, 0, 384400.0, 0, 0};
    auto azel = [&](double lat, double lon) {
        return azimuth_elevation_from_enu(earth_from_lunar_site_enu_km(z, deg_to_rad(lat), deg_to_rad(lon), 0.0));
    };
    CHECK_NEAR(azel(0, 0).second, 90.0, 1e-9);
    CHECK_NEAR(azel(0, -180).second, -90.0, 1e-9);
    // Finite distance: at 90 deg from the sub-Earth point the Earth's centre is below the tangent
    // plane by the horizontal parallax asin(R/d) ~ 0.259 deg.
    const double parallax = rad_to_deg(std::asin(MOON_RADIUS_KM / 384400.0));
    CHECK_NEAR(azel(0, 90).second, -parallax, 1e-3);
    CHECK_NEAR(azel(0, 90).first, 270.0, 1e-9);
    CHECK_NEAR(azel(0, -90).first, 90.0, 1e-9);
    // Poles: finite, deterministic, Earth near the horizon; the request longitude sets "north".
    for (double lat : {-90.0, 90.0}) {
        CHECK(std::isfinite(azel(lat, 0).first) && std::isfinite(azel(lat, 0).second));
        CHECK_NEAR(azel(lat, 0).second, -parallax, 1e-3);
        CHECK_NEAR(azel(lat, 0).second, azel(lat, 123).second, 1e-9);
    }
    CHECK_NEAR(azel(-90, 0).first, 0.0, 1e-9);  // at the south pole the lon-0 meridian points to Earth
    CHECK_NEAR(site_offset_toward_earth_km(z, 0, 0, 0), MOON_RADIUS_KM, 1e-9);
    CHECK_NEAR(site_offset_toward_earth_km(z, 0, deg_to_rad(90), 0), 0.0, 1e-9);
    CHECK_NEAR(site_offset_toward_earth_km(z, 0, deg_to_rad(-180), 0), -MOON_RADIUS_KM, 1e-9);

    // Earth station: a "Moon" straight above (lat 0, lon 0) on the X axis.
    const Vec3 above = {384400.0, 0, 0};
    StationView s = moon_from_earth_station(above, 0, 0, 0);
    CHECK_NEAR(rad_to_deg(s.elevation_rad), 90.0, 1e-9);
    CHECK_NEAR(s.range_km, 384400.0 - EARTH_EQUATORIAL_RADIUS_KM, 1e-9);
    s = moon_from_earth_station(above, 0, deg_to_rad(180), 0);
    CHECK_NEAR(rad_to_deg(s.elevation_rad), -90.0, 1e-9);
    s = moon_from_earth_station(above, deg_to_rad(90), 0, 0);  // pole: polar radius b = a(1 - f)
    CHECK_NEAR(s.range_km, std::hypot(384400.0, EARTH_EQUATORIAL_RADIUS_KM * (1 - EARTH_FLATTENING)), 1e-6);
    CHECK(s.elevation_rad < 0);
}

static void test_radio_link() {
    const json valid = load(CONTRACTS / "fixtures/radio-link-request.valid.json");
    auto run = [](json body) { return app.handle("POST", "/radio/evaluate", body.dump()); };
    auto at = [&](double lat, double lon, double hours, double step) {
        json b = valid;
        b["site"]["latitude_deg"] = lat;
        b["site"]["longitude_deg"] = lon;
        b["duration_hours"] = hours;
        b["step_minutes"] = step;
        return b;
    };

    HttpResponse r = run(valid);
    CHECK(r.status == 200);
    CHECK(r.body["status"] == "computed");
    CHECK(r.body["model"]["tier"] == "engineering");
    CHECK(r.body["model"]["ephemeris_provider"] == "analytic_meeus_truncated");
    CHECK(r.body["request"] == valid);
    CHECK(r.body["samples"].size() == 73);
    CHECK(!r.body["assumptions"].empty());
    // The response must never read as a link guarantee.
    bool disclaimer = false;
    for (const auto& a : r.body["assumptions"])
        disclaimer = disclaimer || a.get<std::string>().find("not a guaranteed radio link") != std::string::npos;
    CHECK(disclaimer);

    // Per-sample consistency and physical bounds for an Earth-Moon link.
    for (const auto& s : r.body["samples"]) {
        CHECK(s["link_available"].get<bool>() ==
              (s["earth_visible"].get<bool>() && s["station_visible"].get<bool>() && s["margin_db"].get<double>() > 0));
        CHECK(s["range_m"].get<double>() > 3.4e8 && s["range_m"].get<double>() < 4.1e8);
        CHECK(std::fabs(s["range_rate_m_s"].get<double>()) < 600.0);  // Earth rotation + lunar orbit
        CHECK_NEAR(s["margin_db"].get<double>(), s["ebn0_db"].get<double>() - 4.0, 1e-9);
        CHECK_NEAR(s["ebn0_db"].get<double>(), s["cn0_dbhz"].get<double>() - 50.0, 1e-9);  // 100 kbit/s
        CHECK(s["doppler_hz"].get<double>() * s["range_rate_m_s"].get<double>() <= 0.0);
    }

    // Sub-Earth equator: Earth always high in the sky (libration only moves it ~8 deg).
    r = run(at(0, 0, 720, 30));
    CHECK(r.body["summary"]["earth_visible_fraction"] == 1.0);
    for (const auto& s : r.body["samples"]) CHECK(s["earth"]["elevation_deg"].get<double>() > 78.0);
    // Three stations ~120 deg apart cover the Moon almost continuously, but not entirely.
    const double ground = r.body["summary"]["ground_station_visible_fraction"].get<double>();
    CHECK(ground > 0.9 && ground <= 1.0);
    CHECK_NEAR(r.body["summary"]["link_available_fraction"].get<double>(), ground, 1e-9);
    // FSPL varies by ~1.1 dB between perigee and apogee.
    const double swing = r.body["summary"]["link_margin_db_max"].get<double>() -
                         r.body["summary"]["link_margin_db_min"].get<double>();
    CHECK(swing > 0.8 && swing < 1.5);

    // Far-side equator: never.
    r = run(at(0, -180, 720, 30));
    CHECK(r.body["summary"]["earth_visible_fraction"] == 0.0);
    CHECK(r.body["summary"]["link_available_fraction"] == 0.0);
    CHECK(r.body["windows"]["link_available"].empty());
    CHECK_NEAR(r.body["summary"]["longest_link_outage_hours"].get<double>(), 720.0, 1e-9);

    // Near the south pole the Earth rises and sets with the latitude libration (~27 d period):
    // visible roughly half of a 60 d span, with outages of many days.
    r = run(at(-89.5, 0, 1440, 60));
    const double polar = r.body["summary"]["earth_visible_fraction"].get<double>();
    CHECK(polar > 0.3 && polar < 0.7);
    CHECK(r.body["summary"]["longest_link_outage_hours"].get<double>() > 200.0);
    for (const auto& s : r.body["samples"]) CHECK(std::fabs(s["earth"]["elevation_deg"].get<double>()) < 8.0);
    CHECK(r.body["warnings"].size() >= 2);  // polar azimuth + low elevation

    // A single station on a rotating Earth sees the Moon about half the time.
    json one = at(0, 0, 720, 30);
    one["stations"] = json::array({valid["stations"][0]});
    r = run(one);
    const double single = r.body["summary"]["link_available_fraction"].get<double>();
    CHECK(single > 0.25 && single < 0.5);
    CHECK(r.body["windows"]["link_available"].size() >= 25);  // about one pass per day

    // Budget that cannot close: no window, and the response says why.
    json weak = at(0, 0, 72, 60);
    weak["link"]["eirp_dbw"] = -30.0;
    r = run(weak);
    CHECK(r.body["summary"]["link_available_fraction"] == 0.0);
    CHECK(r.body["summary"]["link_margin_db_max"].get<double>() < 0.0);
    CHECK(r.body["warnings"][0].get<std::string>().find("never closes") != std::string::npos);
    // A higher lunar-side mask can only shrink the windows.
    json masked = at(-89.5, 0, 1440, 60);
    masked["min_earth_elevation_deg"] = 3.0;
    CHECK(run(masked).body["summary"]["earth_visible_fraction"].get<double>() < polar);

    // Windows: ordered, inside the span, link windows inside Earth and ground windows.
    r = run(at(-85, 20, 720, 30));
    const auto& w = r.body["windows"];
    auto inside = [](const json& inner, const json& outer) {
        for (const auto& a : inner) {
            bool found = false;
            for (const auto& b : outer)
                found = found || (parse_utc(b["start_utc"]) <= parse_utc(a["start_utc"]) &&
                                  parse_utc(a["end_utc"]) <= parse_utc(b["end_utc"]));
            if (!found) return false;
        }
        return true;
    };
    CHECK(inside(w["link_available"], w["earth_visible"]));
    CHECK(inside(w["link_available"], w["ground_station_visible"]));
    for (const auto& st : w["stations"]) CHECK(inside(st["windows"], w["ground_station_visible"]));
    CHECK(w["stations"].size() == 3);
    for (size_t i = 0; i < w["link_available"].size(); ++i) {
        const auto& a = w["link_available"][i];
        CHECK(parse_utc(a["start_utc"]) < parse_utc(a["end_utc"]));
        if (i) CHECK(parse_utc(w["link_available"][i - 1]["end_utc"]) <= parse_utc(a["start_utc"]));
    }

    // Single-sample grid: fractions are undefined, not zero.
    r = run(at(0, 0, 0.5, 60));
    CHECK(r.status == 200 && r.body["samples"].size() == 1);
    CHECK(r.body["summary"]["link_available_fraction"].is_null());

    // Validation.
    CHECK(app.handle("GET", "/radio/evaluate", "").status == 405);
    CHECK(app.handle("POST", "/radio/evaluate", "").status == 422);
    CHECK(app.handle("POST", "/radio/evaluate", "{bad").status == 422);
    CHECK(run(json::array()).status == 422);
    json dup = valid;
    dup["stations"][1]["name"] = dup["stations"][0]["name"];
    CHECK(run(dup).status == 422);
    json many = valid;
    many["duration_hours"] = 2160;
    many["step_minutes"] = 1;
    CHECK(run(many).status == 422);  // 129601 samples > MAX_SAMPLES
    int n_invalid = 0;
    for (const auto& entry : fs::directory_iterator(CONTRACTS / "fixtures/invalid-radio-link-requests")) {
        ++n_invalid;
        HttpResponse u = run(load(entry.path()));
        if (u.status != 422) std::fprintf(stderr, "accepted invalid fixture %s\n", entry.path().string().c_str());
        CHECK(u.status == 422);
        CHECK(u.body["error"]["code"] == "validation_error");
    }
    CHECK(n_invalid >= 10);

    // Live output still matches the generated contract fixture.
    CHECK(radio_near(run(valid).body, load(CONTRACTS / "fixtures/radio-link-response.computed.json")));
}

// ---------- DEM terrain horizon (SYNTHETIC DEMs) ----------

static std::shared_ptr<const Dem> horizon_dem(const std::string& id, int n, double scale_m,
                                              const std::function<double(double, double)>& z_m) {
    return selene::testing::square_dem(id, n, scale_m, z_m);
}

static void test_terrain_horizon() {
    const double R = 1737400.0;
    const int N = 1201;  // 120 km square at 100 m: 60 km of terrain around the pole
    const HorizonOptions opt{360, 55000.0, 50000.0};

    // 1. Smooth sphere: the horizon is the geometric dip -acos(R / (R + h)), the same in every
    //    direction (SCIENTIFIC_REFERENCE section 6), NOT 0.
    auto flat = horizon_dem("SYNTHETIC_FLAT", N, 100.0, [](double, double) { return 0.0; });
    for (double h_obs : {2.0, 100.0}) {
        const HorizonProfile p = terrain_horizon(*flat, -90.0, 0.0, h_obs, opt);
        const double dip = -rad_to_deg(std::acos(R / (R + h_obs)));
        CHECK(p.elevation_deg.size() == 360);
        for (double e : p.elevation_deg) CHECK_NEAR(e, dip, 2e-3);
        CHECK(p.truncated_bearings == 0 && p.nodata_samples == 0);
        CHECK_NEAR(p.site_surface_height_m, 0.0, 1e-9);
        // the tangent point is at ground distance R * acos(R / (R + h))
        CHECK_NEAR(p.horizon_range_m[0], R * std::acos(R / (R + h_obs)), 0.02 * R * std::acos(R / (R + h_obs)) + 100.0);
    }

    // 2. A wall 1000 m high beyond up >= 10 km (toward lon 0, which is azimuth 0 at the south
    //    pole for a lon-0 request). Expected elevation of its foot-line crest from 2 m above the
    //    pole, with curvature: atan2((R+H) cos(d/R) - (R+h), (R+H) sin(d/R)).
    auto wall = selene::testing::wall_dem();
    const HorizonProfile pw = terrain_horizon(*wall, -90.0, 0.0, 2.0, opt);
    const double d_wall = 10000.0, delta = d_wall / R;
    const double expected = rad_to_deg(std::atan2((R + 1000.0) * std::cos(delta) - (R + 2.0), (R + 1000.0) * std::sin(delta)));
    CHECK_NEAR(pw.elevation_deg[0], expected, 0.06);  // one 100 m pixel of edge position ~ 0.05 deg
    CHECK(expected > 5.45 && expected < 5.6);          // atan(998/10000) = 5.70 deg, minus 0.165 deg of curvature
    CHECK_NEAR(pw.horizon_range_m[0], d_wall, 150.0);
    // Facing away (azimuth 180) and sideways (90, 270) the wall is not seen or seen obliquely.
    CHECK_NEAR(pw.elevation_deg[180], -rad_to_deg(std::acos(R / (R + 2.0))), 2e-3);
    CHECK(pw.elevation_deg[60] > 0 && pw.elevation_deg[60] < pw.elevation_deg[0]);  // wall at 20 km along that bearing
    CHECK_NEAR(pw.elevation_deg[60], rad_to_deg(std::atan2((R + 1000.0) * std::cos(20000.0 / R) - (R + 2.0),
                                                           (R + 1000.0) * std::sin(20000.0 / R))), 0.06);
    // Symmetry about the wall's normal.
    for (int a : {10, 30, 60, 85}) CHECK_NEAR(pw.elevation_deg[a], pw.elevation_deg[360 - a], 0.02);
    // Interpolation between bearings and wrap-around.
    CHECK_NEAR(horizon_elevation_deg(pw, 0.5), (pw.elevation_deg[0] + pw.elevation_deg[1]) / 2, 1e-12);
    CHECK_NEAR(horizon_elevation_deg(pw, 359.5), (pw.elevation_deg[359] + pw.elevation_deg[0]) / 2, 1e-12);
    CHECK_NEAR(horizon_elevation_deg(pw, 360.0), pw.elevation_deg[0], 1e-12);
    CHECK_NEAR(horizon_elevation_deg(pw, -90.0), pw.elevation_deg[270], 1e-12);

    // 3. The azimuth convention follows the request longitude: the same wall seen from the pole
    //    with a lon 90 E request sits at azimuth 270 (north = meridian 90 E, the wall is toward lon 0).
    const HorizonProfile pr = terrain_horizon(*wall, -90.0, 90.0, 2.0, opt);
    CHECK_NEAR(pr.elevation_deg[270], pw.elevation_deg[0], 0.02);

    // 4. Bowl: observer at the bottom of a 2 km deep, 20 km wide parabolic pit sees its rim all
    //    around; the surface height under the site is the pit floor. (Smooth on purpose: the
    //    bilinear DEM interpolation is then accurate; a cone's apex is not representable.)
    auto bowl = horizon_dem("SYNTHETIC_BOWL", N, 100.0, [](double x, double y) {
        return std::min(0.0, -2000.0 + 2e-5 * (x * x + y * y));  // 0 m beyond 10 km
    });
    const HorizonProfile pb = terrain_horizon(*bowl, -90.0, 0.0, 2.0, opt);
    CHECK_NEAR(pb.site_surface_height_m, -2000.0, 15.0);
    // Expected = max over the wall of the exact curved-geometry elevation (reached at the rim).
    double wall_max = -90.0;
    for (double dist = 100.0; dist <= 10000.0; dist += 10.0) {
        const double rt = R - 2000.0 + 2e-5 * dist * dist;
        wall_max = std::max(wall_max, rad_to_deg(std::atan2(rt * std::cos(dist / R) - (R - 2000.0 + 2.0), rt * std::sin(dist / R))));
    }
    for (double e : pb.elevation_deg) CHECK_NEAR(e, wall_max, 0.08);
    CHECK(wall_max > 11.0 && wall_max < 11.31);  // atan(2000/10000) = 11.31 deg, minus curvature and the 2 m

    // 5. Off-pole observer on the flat sphere: still the dip in every direction (the great-circle
    //    ray geometry does not depend on where the site is).
    const HorizonProfile po = terrain_horizon(*flat, -89.9, 37.0, 2.0, HorizonOptions{360, 20000.0, 20000.0});
    for (double e : po.elevation_deg) CHECK_NEAR(e, -rad_to_deg(std::acos(R / (R + 2.0))), 2e-3);

    // 6. Coverage and no-data are never filled in.
    //    Site outside the grid, and a site too close to its edge, are refused.
    CHECK_THROWS(terrain_horizon(*flat, -80.0, 0.0, 2.0, opt), HorizonError);
    CHECK_THROWS(terrain_horizon(*flat, -88.5, 0.0, 2.0, opt), HorizonError);  // 45 km from the pole: 15 km to the edge
    //    Declared coverage limit (like 85 S on LDEM_85S_20M) stops the rays too.
    {
        DemInfo d = flat->info();
        d.max_latitude_deg = -89.0;  // 30.3 km around the pole
        std::vector<float> h(static_cast<std::size_t>(N) * N, 0.0f);
        auto limited = Dem::in_memory(std::move(d), std::move(h));
        CHECK_THROWS(terrain_horizon(*limited, -90.0, 0.0, 2.0, opt), HorizonError);  // 30 km < 50 km needed
        const HorizonProfile pl = terrain_horizon(*limited, -90.0, 0.0, 2.0, HorizonOptions{360, 55000.0, 25000.0});
        CHECK(pl.truncated_bearings == 360);
        CHECK(pl.min_covered_range_m > 29000.0 && pl.min_covered_range_m < 30400.0);
    }
    //    No data under the site.
    auto hole = horizon_dem("SYNTHETIC_HOLE", N, 100.0, [](double x, double y) {
        return std::hypot(x, y) < 300.0 ? std::nan("") : 0.0;
    });
    CHECK_THROWS(terrain_horizon(*hole, -90.0, 0.0, 2.0, opt), HorizonError);
    //    A no-data patch away from the site is skipped and counted, not treated as terrain.
    auto patch = horizon_dem("SYNTHETIC_PATCH", N, 100.0, [](double x, double y) {
        return std::hypot(x - 5000.0, y) < 1000.0 ? std::nan("") : 0.0;
    });
    const HorizonProfile pp = terrain_horizon(*patch, -90.0, 0.0, 2.0, opt);
    CHECK(pp.nodata_samples > 0);
    for (double e : pp.elevation_deg) CHECK_NEAR(e, -rad_to_deg(std::acos(R / (R + 2.0))), 2e-3);

    // 7. Cache: same site hits, another site or DEM misses.
    HorizonCache cache(2);
    auto a1 = cache.get(*wall, -90.0, 0.0, 2.0, opt), a2 = cache.get(*wall, -90.0, 0.0, 2.0, opt);
    CHECK(a1 == a2 && cache.stats().hits == 1 && cache.stats().misses == 1);
    cache.get(*wall, -90.0, 0.0, 3.0, opt);
    cache.get(*flat, -90.0, 0.0, 2.0, opt);
    CHECK(cache.stats().misses == 3 && cache.stats().size == 2);
}

// terrain_mode "dem" through the app: windows follow the terrain horizon, labels are honest.
static void test_evaluate_with_terrain() {
    const json valid = load(CONTRACTS / "fixtures/scenario-request.valid.json");
    json req = valid;
    req["site"]["latitude_deg"] = -90.0;
    req["terrain_mode"] = "dem";
    req["duration_hours"] = 240;
    req["step_minutes"] = 30;

    // No DEM: not_ready with the reason, no numbers.
    HttpResponse r = post("/evaluate/synthetic", req);
    CHECK(r.body["status"] == "not_ready" && r.body["samples"].empty() && !r.body.contains("terrain_horizon"));
    CHECK(r.body["message"].get<std::string>().find("SELENE_DEM_PATH not set") != std::string::npos);

    // Flat synthetic DEM under the synthetic ephemeris: every sample carries the horizon (the dip
    // of a 2 m observer), and a body is in a window exactly when elevation > horizon.
    auto flat = horizon_dem("SYNTHETIC_FLAT", 1201, 100.0, [](double, double) { return 0.0; });
    const App on_flat(std::nullopt, flat);
    r = on_flat.handle("POST", "/evaluate/synthetic", req.dump());
    CHECK(r.status == 200);
    CHECK(r.body["status"] == "synthetic" && r.body["synthetic"] == true);
    CHECK(r.body["model"]["horizon_model"] == "dem_terrain");
    const json& th = r.body["terrain_horizon"];
    CHECK(th["elevation_deg"].size() == 720 && th["azimuth_step_deg"] == 0.5);
    CHECK_NEAR(th["observer_radius_m"].get<double>(), 1737402.0, 1e-6);
    const double dip = -rad_to_deg(std::acos(1737400.0 / 1737402.0));
    for (const auto& s : r.body["samples"]) {
        CHECK_NEAR(s["sun"]["horizon_elevation_deg"].get<double>(), dip, 2e-3);
        CHECK_NEAR(s["earth"]["horizon_elevation_deg"].get<double>(), dip, 2e-3);
    }
    bool dem_listed = false, synthetic_dem_warning = false;
    for (const auto& p : r.body["data_provenance"]) dem_listed = dem_listed || p["name"] == "SYNTHETIC_FLAT";
    for (const auto& w : r.body["warnings"])
        synthetic_dem_warning = synthetic_dem_warning || w.get<std::string>().find("SYNTHETIC DEM") != std::string::npos;
    CHECK(dem_listed && synthetic_dem_warning);

    // Windows == runs of samples with elevation > horizon (sample-level check, both bodies).
    auto check_windows = [&](const json& body, const char* who, const char* key) {
        for (const auto& s : body["samples"]) {
            const int64_t t = parse_utc(s["utc"]);
            const bool above = s[who]["elevation_deg"].get<double>() > s[who]["horizon_elevation_deg"].get<double>();
            bool inside = false;
            for (const auto& w : body["windows"][key])
                inside = inside || (parse_utc(w["start_utc"]) <= t && t <= parse_utc(w["end_utc"]));
            if (above != inside) {
                // a sample exactly on a window edge may fall on either side of the interpolation
                bool on_edge = false;
                for (const auto& w : body["windows"][key])
                    on_edge = on_edge || std::llabs(parse_utc(w["start_utc"]) - t) < 1000 || std::llabs(parse_utc(w["end_utc"]) - t) < 1000;
                CHECK(on_edge);
            }
        }
    };
    check_windows(r.body, "sun", "sun_visible");
    check_windows(r.body, "earth", "earth_visible");

    // A 20 km-wide, 2 km-deep pit: rim at ~11.1 deg all around, above the synthetic waveforms
    // (|elevation| <= 3.5 deg): nothing is ever visible, although the ideal horizon shows windows.
    auto bowl = horizon_dem("SYNTHETIC_BOWL", 1201, 100.0, [](double x, double y) {
        return std::min(0.0, -2000.0 + 2e-5 * (x * x + y * y));
    });
    const App in_bowl(std::nullopt, bowl);
    r = in_bowl.handle("POST", "/evaluate/synthetic", req.dump());
    CHECK(r.body["windows"]["sun_visible"].empty() && r.body["windows"]["earth_visible"].empty());
    CHECK_NEAR(r.body["terrain_horizon"]["site_surface_height_m"].get<double>(), -2000.0, 15.0);
    json ideal = req;
    ideal["terrain_mode"] = "ideal";
    HttpResponse ri = in_bowl.handle("POST", "/evaluate/synthetic", ideal.dump());
    CHECK(!ri.body["windows"]["sun_visible"].empty());
    CHECK(!ri.body.contains("terrain_horizon") && !ri.body["samples"][0]["sun"].contains("horizon_elevation_deg"));

    // Live output still matches the generated contract fixture (SYNTHETIC wall DEM).
    {
        const App on_wall(std::nullopt, selene::testing::wall_dem());
        json fx = valid;
        fx["site"]["latitude_deg"] = -90.0;
        fx["terrain_mode"] = "dem";
        fx["duration_hours"] = 48;
        fx["step_minutes"] = 360;
        CHECK(json_near(on_wall.handle("POST", "/evaluate/synthetic", fx.dump()).body,
                        load(CONTRACTS / "fixtures/scenario-response.synthetic-dem.json"), 1e-7));
    }

    // Site the DEM cannot serve: not_ready with the reason, no numbers.
    json far = req;
    far["site"]["latitude_deg"] = -80.0;
    r = on_flat.handle("POST", "/evaluate/synthetic", far.dump());
    CHECK(r.body["status"] == "not_ready" && r.body["samples"].empty());
    CHECK(r.body["message"].get<std::string>().find("outside the coverage") != std::string::npos);
    far["site"]["latitude_deg"] = -88.5;
    r = on_flat.handle("POST", "/evaluate/synthetic", far.dump());
    CHECK(r.body["status"] == "not_ready");
    CHECK(r.body["message"].get<std::string>().find("too close to the edge") != std::string::npos);
}

// POST /celestial/state and /celestial/tracks without kernels: validation works, and no position is ever invented.
static void test_celestial_state_without_kernels() {
    const json valid = load(CONTRACTS / "fixtures/celestial-state-request.valid.json");
    for (const char* path : {"/celestial/state", "/celestial/tracks"}) {
        HttpResponse r = app.handle("POST", path, valid.dump());
        CHECK(r.status == 503);
        CHECK(r.body["error"]["code"] == "science_unavailable");
        CHECK(r.body["error"]["message"].get<std::string>().find("SELENE_KERNEL_DIR not set") != std::string::npos);
        CHECK(!r.body.contains("moon_from_earth"));
        CHECK(app.handle("GET", path, "").status == 405);
        CHECK(app.handle("POST", path, "").status == 422);
        CHECK(app.handle("POST", path, "{bad").status == 422);
        CHECK(app.handle("POST", path, "[]").status == 422);
        int n_invalid = 0;
        for (const auto& entry : fs::directory_iterator(CONTRACTS / "fixtures/invalid-celestial-state-requests")) {
            ++n_invalid;
            r = app.handle("POST", path, load(entry.path()).dump());
            if (r.status != 422) std::fprintf(stderr, "%s accepted invalid fixture %s\n", path, entry.path().string().c_str());
            CHECK(r.status == 422 && r.body["error"]["code"] == "validation_error");
        }
        CHECK(n_invalid >= 5);
    }
}

static void test_time() {
    CHECK(format_utc(parse_utc("2026-11-15T00:00:00Z")) == "2026-11-15T00:00:00.000Z");
    CHECK(format_utc(parse_utc("1970-01-01T00:00:00Z")) == "1970-01-01T00:00:00.000Z");
    CHECK(parse_utc("1970-01-01T00:00:01.5Z") == 1500000);
    // fractions beyond microseconds truncate; output milliseconds truncate
    CHECK(format_utc(parse_utc("2024-02-29T23:59:59.9999999Z")) == "2024-02-29T23:59:59.999Z");
    CHECK(format_utc(parse_utc("0001-01-01T00:00:00Z")) == "0001-01-01T00:00:00.000Z");
    CHECK(format_utc(parse_utc("1969-12-31T23:59:59.250Z")) == "1969-12-31T23:59:59.250Z");
    CHECK_THROWS(parse_utc("2026-02-30T00:00:00Z"), std::invalid_argument);
    CHECK_THROWS(parse_utc("2025-02-29T00:00:00Z"), std::invalid_argument);
    CHECK_THROWS(parse_utc("0000-01-01T00:00:00Z"), std::invalid_argument);
    CHECK_THROWS(parse_utc("2026-01-01T24:00:00Z"), std::invalid_argument);
    CHECK_THROWS(parse_utc("2026-01-01T00:00:60Z"), std::invalid_argument);
    CHECK_THROWS(parse_utc("2026-11-15T00:00:00+02:00"), std::invalid_argument);
}

// ---------- API ----------

static void test_api() {
    const json valid = load(CONTRACTS / "fixtures/scenario-request.valid.json");

    auto r = app.handle("GET", "/health", "");
    CHECK(r.status == 200);
    CHECK(r.body["service"] == "science");
    CHECK(r.body["ephemeris"]["provider"] == "spice");
    CHECK(r.body["ephemeris"]["ready"] == false);
    CHECK(r.body["ephemeris"]["reason"].get<std::string>().find("SELENE_KERNEL_DIR not set") != std::string::npos);

    // real provider: not ready, no numbers
    r = post("/evaluate", valid);
    CHECK(r.status == 200);
    CHECK(r.body["status"] == "not_ready");
    CHECK(r.body["synthetic"] == false);
    CHECK(r.body["samples"].empty());
    CHECK(r.body["windows"]["sun_visible"].empty() && r.body["windows"]["earth_visible"].empty());
    CHECK(json_near(r.body["request"], valid));

    // synthetic is labelled
    r = post("/evaluate/synthetic", valid);
    CHECK(r.status == 200);
    CHECK(r.body["status"] == "synthetic");
    CHECK(r.body["synthetic"] == true);
    CHECK(r.body["model"]["ephemeris_provider"] == "synthetic_fixture");
    CHECK(r.body["warnings"][0].get<std::string>().find("SYNTHETIC") != std::string::npos);
    for (const auto& p : r.body["data_provenance"]) CHECK(p["kind"] == "synthetic");
    CHECK(r.body["samples"].size() == 72 * 6 + 1);  // 72 h at 10 min, inclusive end
    CHECK(r.body["samples"].front()["utc"] == "2026-11-15T00:00:00.000Z");
    CHECK(r.body["samples"].back()["utc"] == "2026-11-18T00:00:00.000Z");
    CHECK(!r.body["windows"]["sun_visible"].empty());
    for (const auto& s : r.body["samples"]) {
        for (const char* body : {"sun", "earth"}) {
            double a = s[body]["azimuth_deg"], e = s[body]["elevation_deg"];
            CHECK(a >= 0 && a < 360 && e >= -90 && e <= 90);
        }
    }

    // polar site warns
    bool polar = false;
    for (const auto& w : r.body["warnings"])
        polar = polar || w.get<std::string>().find("ill-conditioned") != std::string::npos;
    CHECK(polar);

    // DEM mode not ready
    json dem = valid;
    dem["terrain_mode"] = "dem";
    r = post("/evaluate/synthetic", dem);  // this app has no DEM
    CHECK(r.body["status"] == "not_ready");
    CHECK(r.body["model"]["horizon_model"] == "dem_terrain");
    CHECK(r.body["samples"].empty());

    // validation error envelope
    json bad = valid;
    bad["site"]["latitude_deg"] = 95;
    r = post("/evaluate", bad);
    CHECK(r.status == 422);
    CHECK(r.body["error"]["code"] == "validation_error");
    CHECK(r.body["error"]["details"][0]["field"] == "site.latitude_deg");

    // impossible date
    bad = valid;
    bad["start_utc"] = "2026-02-30T00:00:00Z";
    CHECK(post("/evaluate", bad).status == 422);

    // too many samples
    bad = valid;
    bad["duration_hours"] = 2160;
    bad["step_minutes"] = 1;
    r = post("/evaluate", bad);
    CHECK(r.status == 422);
    CHECK(r.body["error"]["details"][0]["field"] == "step_minutes");

    // strict types (the JSON Schema says number / string)
    bad = valid;
    bad["duration_hours"] = "72";
    CHECK(post("/evaluate", bad).status == 422);
    bad = valid;
    bad["site"]["latitude_deg"] = true;
    CHECK(post("/evaluate", bad).status == 422);

    // malformed bodies and routing
    CHECK(app.handle("POST", "/evaluate", "{bad").status == 422);
    CHECK(app.handle("POST", "/evaluate", "").status == 422);
    CHECK(app.handle("POST", "/evaluate", "[1]").status == 422);
    CHECK(app.handle("GET", "/nope", "").status == 404);
    CHECK(app.handle("GET", "/evaluate", "").status == 405);
}

// ---------- terrain slope check (SYNTHETIC DEMs, tests/synthetic_dem.hpp) ----------

using selene::testing::SYN_N;
using selene::testing::SYN_POLE;

static json slope_req(double lat, double lon, double radius_m, double max_slope) {
    return {{"zone", {{"center_latitude_deg", lat}, {"center_longitude_deg", lon}, {"radius_m", radius_m}}},
            {"max_slope_deg", max_slope}};
}

static json check_on(const std::shared_ptr<const Dem>& dem, const json& body) {
    const App a(std::nullopt, dem);
    HttpResponse r = a.handle("POST", "/terrain/slope/check", body.dump());
    CHECK(r.status == 200);
    return r.body;
}

static void test_slope_check() {
    using namespace selene::testing;
    // Zone centres are given at pixel centres through the exact inverse projection.
    const DemInfo info = synthetic_info("x");
    const LatLon centre = dem_latlon_of(info, SYN_POLE - 30, SYN_POLE + 20);  // ~720 m from the pole
    CHECK_NEAR(dem_pixel_of(info, centre.lat_deg, centre.lon_deg).line, SYN_POLE - 30, 1e-6);
    CHECK_NEAR(dem_pixel_of(info, centre.lat_deg, centre.lon_deg).sample, SYN_POLE + 20, 1e-6);

    // flat -> pass, slope exactly 0; pixel count ~ pi r^2 / spacing^2 (spacing ~ 20 m here)
    auto flat = synthetic_dem("SYNTHETIC_FLAT", [](double, double) { return 1234.0; });
    json r = check_on(flat, slope_req(centre.lat_deg, centre.lon_deg, 500, 2));
    CHECK(r["status"] == "computed");
    CHECK(r["verdict"] == "pass");
    CHECK(r["stats"]["slope_max_deg"] == 0.0);
    CHECK(r["stats"]["nodata_count"] == 0);
    CHECK(r["stats"]["fraction_ok"] == 1.0);
    const double expect = 3.14159265358979 * 500 * 500 / (20.0 * 20.0);
    const double n = r["stats"]["pixel_count"].get<double>();
    CHECK(std::fabs(n - expect) / expect < 0.02);
    CHECK(r["request"]["required_fraction"] == 1.0 && r["request"]["max_nodata_fraction"] == 0.0);
    CHECK(r["model"]["baseline_m"] == 20.0);
    CHECK(r["data_provenance"]["synthetic"] == true);
    CHECK(r["warnings"][0].get<std::string>().find("SYNTHETIC") != std::string::npos);
    // radius 20 m (lower bound) still selects the centre pixel and its 4 neighbours (at ~20 m)
    r = check_on(flat, slope_req(centre.lat_deg, centre.lon_deg, 20, 2));
    CHECK(r["stats"]["pixel_count"].get<int>() >= 1 && r["stats"]["pixel_count"].get<int>() <= 5);

    // tilted plane at 10 deg: threshold boundary (spacing correction error ~3e-4 relative here)
    auto tilt = tilted_plane_dem(10.0);
    r = check_on(tilt, slope_req(centre.lat_deg, centre.lon_deg, 500, 10.05));
    CHECK(r["verdict"] == "pass");
    CHECK_NEAR(r["stats"]["slope_max_deg"].get<double>(), 10.0, 0.02);
    CHECK_NEAR(r["stats"]["slope_mean_deg"].get<double>(), 10.0, 0.02);
    CHECK_NEAR(r["stats"]["slope_p95_deg"].get<double>(), 10.0, 0.02);
    r = check_on(tilt, slope_req(centre.lat_deg, centre.lon_deg, 500, 9.95));
    CHECK(r["verdict"] == "fail");
    CHECK(r["stats"]["fraction_ok"] == 0.0);

    // required_fraction: 20 deg ramp east of a vertical line through the centre, flat west of it
    const double g20 = std::tan(20.0 / 180.0 * 3.14159265358979);
    const double xc = (SYN_POLE + 20 - SYN_POLE) * 20.0;
    auto half = synthetic_dem("SYNTHETIC_HALF_RAMP",
                              [=](double x, double) { return x > xc ? g20 * (x - xc) : 0.0; });
    json body = slope_req(centre.lat_deg, centre.lon_deg, 500, 10);
    r = check_on(half, body);
    const double fok = r["stats"]["fraction_ok"].get<double>();
    CHECK(fok > 0.45 && fok < 0.55);
    CHECK(r["verdict"] == "fail");  // default required_fraction = 1
    body["required_fraction"] = 0.4;
    CHECK(check_on(half, body)["verdict"] == "pass");
    body["required_fraction"] = 0.6;
    CHECK(check_on(half, body)["verdict"] == "fail");

    // worst pixel: single 30 m spike 5 px up-left (image) of the centre -> worst pixel lies next to it
    const double sx = (SYN_POLE + 15 - SYN_POLE) * 20.0, sy = -((SYN_POLE - 35) - SYN_POLE) * 20.0;
    auto spike = synthetic_dem("SYNTHETIC_SPIKE", [=](double x, double y) {
        return std::fabs(x - sx) < 1 && std::fabs(y - sy) < 1 ? 30.0 : 0.0;
    });
    r = check_on(spike, slope_req(centre.lat_deg, centre.lon_deg, 500, 10));
    CHECK(r["verdict"] == "fail");
    const json& w = r["stats"]["worst_pixel"];
    const GridPos wp = dem_pixel_of(info, w["latitude_deg"], w["longitude_deg"]);
    CHECK(std::fabs(wp.line - (SYN_POLE - 35)) <= 1.0 + 1e-6 && std::fabs(wp.sample - (SYN_POLE + 15)) <= 1.0 + 1e-6);
    CHECK(w["slope_deg"] == r["stats"]["slope_max_deg"]);

    // no-data: one NaN pixel inside the zone -> its 3x3 neighbourhood has no slope
    auto hole = synthetic_dem("SYNTHETIC_HOLE", [=](double x, double y) {
        return std::fabs(x - xc) < 1 && std::fabs(y - 30 * 20.0) < 1 ? NAN : 0.0;
    });
    body = slope_req(centre.lat_deg, centre.lon_deg, 500, 10);
    r = check_on(hole, body);
    CHECK(r["status"] == "computed");
    CHECK(r["verdict"] == "insufficient_data");
    CHECK(r["stats"]["nodata_count"] == 9);
    CHECK(r["stats"]["fraction_ok"] == 1.0);
    body["max_nodata_fraction"] = 0.01;
    CHECK(check_on(hole, body)["verdict"] == "pass");
    // all no-data -> insufficient even when every pixel may be missing
    auto empty = synthetic_dem("SYNTHETIC_EMPTY", [](double, double) { return NAN; });
    body["max_nodata_fraction"] = 1.0;
    r = check_on(empty, body);
    CHECK(r["verdict"] == "insufficient_data");
    CHECK(r["stats"]["slope_max_deg"].is_null() && r["stats"]["worst_pixel"].is_null());
    CHECK(r["stats"]["nodata_count"] == r["stats"]["pixel_count"]);

    // out of coverage: zone crossing the grid edge, far outside, other hemisphere
    const LatLon edge = dem_latlon_of(info, SYN_POLE, SYN_N - 10);
    for (const json& b : {slope_req(edge.lat_deg, edge.lon_deg, 500, 10), slope_req(-85.0, 0, 500, 10),
                          slope_req(45.0, 10, 500, 10), slope_req(90.0, 0, 10000, 10)}) {
        r = check_on(flat, b);
        CHECK(r["status"] == "out_of_coverage");
        CHECK(r["verdict"] == "not_evaluated");
        CHECK(r["stats"].is_null());
    }
    // a zone just inside the edge is fine (box 2 px from the border, radius 1 px)
    const LatLon in_edge = dem_latlon_of(info, SYN_POLE, SYN_N - 3);
    CHECK(check_on(flat, slope_req(in_edge.lat_deg, in_edge.lon_deg, 20, 10))["status"] == "computed");

    // exact pole: longitude ignored, deterministic
    r = check_on(flat, slope_req(-90.0, 0, 200, 1));
    CHECK(r["status"] == "computed");
    CHECK(json_near(r["stats"], check_on(flat, slope_req(-90.0, 123.0, 200, 1))["stats"]));

    // no DEM -> dem_unavailable (HTTP 200, like scenario not_ready)
    auto u = app.handle("POST", "/terrain/slope/check", slope_req(-89.5, 0, 500, 10).dump());
    CHECK(u.status == 200);
    CHECK(u.body["status"] == "dem_unavailable");
    CHECK(u.body["verdict"] == "not_evaluated");
    CHECK(u.body["stats"].is_null());
    CHECK(u.body["model"]["baseline_m"].is_null());

    // validation
    for (const json& bad : {json::array(), json{{"zone", 1}, {"max_slope_deg", 10}},
                            json{{"zone", {{"center_latitude_deg", -89.5}, {"center_longitude_deg", 0}, {"radius_m", 500}}},
                                 {"max_slope_deg", "10"}}}) {
        u = app.handle("POST", "/terrain/slope/check", bad.dump());
        CHECK(u.status == 422);
        CHECK(u.body["error"]["code"] == "validation_error");
    }
    CHECK(app.handle("POST", "/terrain/slope/check", "{bad").status == 422);
    CHECK(app.handle("GET", "/terrain/slope/check", "").status == 405);
    int n_invalid = 0;
    for (const auto& entry : fs::directory_iterator(CONTRACTS / "fixtures/invalid-slope-check-requests")) {
        ++n_invalid;
        const App a(std::nullopt, flat);
        u = a.handle("POST", "/terrain/slope/check", load(entry.path()).dump());
        if (u.status != 422) std::fprintf(stderr, "accepted invalid fixture %s\n", entry.path().string().c_str());
        CHECK(u.status == 422);
    }
    CHECK(n_invalid >= 5);
}

// Response cache: repeated request hits, other inputs / other DEM identity miss, LRU bound.
static void test_slope_cache() {
    using namespace selene::testing;
    auto flat = synthetic_dem("SYNTHETIC_FLAT", [](double, double) { return 0.0; });
    const App a(std::nullopt, flat);
    const json body = slope_req(-90.0, 0, 300, 2);
    auto r1 = a.handle("POST", "/terrain/slope/check", body.dump());
    CHECK(a.slope_cache_stats().hits == 0 && a.slope_cache_stats().misses == 1);
    auto r2 = a.handle("POST", "/terrain/slope/check", body.dump());
    CHECK(a.slope_cache_stats().hits == 1 && a.slope_cache_stats().size == 1);
    CHECK(r1.status == 200 && r2.status == 200 && r1.body == r2.body);
    // explicit defaults normalize to the same key as omitted ones
    json with_defaults = body;
    with_defaults["required_fraction"] = 1.0;
    with_defaults["max_nodata_fraction"] = 0.0;
    a.handle("POST", "/terrain/slope/check", with_defaults.dump());
    CHECK(a.slope_cache_stats().hits == 2);
    // a different threshold misses
    a.handle("POST", "/terrain/slope/check", slope_req(-90.0, 0, 300, 3).dump());
    CHECK(a.slope_cache_stats().hits == 2 && a.slope_cache_stats().size == 2);
    // validation errors and dem_unavailable never touch the cache
    a.handle("POST", "/terrain/slope/check", "{}");
    CHECK(a.slope_cache_stats().misses == 2);
    const App none(std::nullopt);
    none.handle("POST", "/terrain/slope/check", body.dump());
    CHECK(none.slope_cache_stats().size == 0);

    // same request, different DEM identity -> different key -> miss
    const SlopeCheckRequest req = parse_slope_check_request(body);
    DemInfo d1 = synthetic_info("A"), d2 = synthetic_info("A");
    d1.identity = "LDEM|100|1|aaa";
    d2.identity = "LDEM|100|2|aaa";  // e.g. same product id and size, new mtime
    CHECK(slope_cache_key(req, d1) != slope_cache_key(req, d2));
    SlopeCache c(2);
    c.put(slope_cache_key(req, d1), json{{"v", 1}});
    CHECK(!c.get(slope_cache_key(req, d2)));
    CHECK(c.get(slope_cache_key(req, d1)) == json({{"v", 1}}));
    // capacity 2: least recently used entry is evicted
    c.put("k2", 2);
    c.get(slope_cache_key(req, d1));
    c.put("k3", 3);
    CHECK(c.stats().size == 2 && !c.get("k2") && c.get("k3") && c.get(slope_cache_key(req, d1)));
}

// A tiny PDS-like .IMG/.LBL pair on disk: label parser, size check, SHA256SUMS, window reads.
static void test_dem_file() {
    const fs::path dir = fs::temp_directory_path() / "selene-dem-test";
    fs::create_directories(dir);
    const int N = 64;
    std::vector<float> h(N * N);
    for (int l = 0; l < N; ++l)
        for (int s = 0; s < N; ++s) h[l * N + s] = l == 40 && s == 40 ? -1e30f : 0.5f;  // one invalid DN
    std::ofstream(dir / "tiny.img", std::ios::binary).write(reinterpret_cast<const char*>(h.data()), N * N * 4);
    // `meta` replaces the identification keywords (DATA_SET_ID, PRODUCER_*, ...) per variant.
    auto write_label = [&](const fs::path& p, const std::string& meta) {
        std::ofstream(p) << "PDS_VERSION_ID = \"PDS3\"\nPRODUCT_VERSION_ID = \"V0\"\n"
                            "PRODUCT_ID = \"TINY_TEST\"\n" << meta <<
                            "START_TIME = 2009-07-13T17:33:17\nSTOP_TIME = 2017-02-02T22:18:35\n"
                            "RECORD_BYTES = 256\nLINES = 64\nLINE_SAMPLES = 64\n"
                            "SAMPLE_TYPE = PC_REAL\nUNIT = KILOMETER\nSCALING_FACTOR = 1\nOFFSET = 1737.4\n"
                            "MAP_PROJECTION_TYPE = \"POLAR STEREOGRAPHIC\"\nA_AXIS_RADIUS = 1737.4 <km>\n"
                            "B_AXIS_RADIUS = 1737.4 <km>\nC_AXIS_RADIUS = 1737.4 <km>\n"
                            "CENTER_LATITUDE = -90 <deg>\nCENTER_LONGITUDE = 0 <deg>\n"
                            "MAP_PROJECTION_ROTATION = 0.0\nMAP_SCALE = 20 <m/pix>\n"
                            "LINE_PROJECTION_OFFSET = 31.5 <pix>\nSAMPLE_PROJECTION_OFFSET = 31.5 <pix>\n"
                            "MAXIMUM_LATITUDE = -89.99 <deg>\n"
                            "COORDINATE_SYSTEM_NAME = \"MEAN EARTH/POLAR AXIS OF DE421\"\nEND\n";
    };
    write_label(dir / "tiny.lbl", "DATA_SET_ID = \"TEST\"\n");
    std::ofstream(dir / "SHA256SUMS") << std::string(64, 'a') << "  tiny.img\n";
    auto dem = Dem::open_pds_auto(dir / "tiny.img", std::nullopt);
    CHECK(dem->info().product_id == "TINY_TEST");
    CHECK(dem->info().frame == "MEAN EARTH/POLAR AXIS OF DE421");
    CHECK(dem->info().sha256 && *dem->info().sha256 == std::string(64, 'a'));
    float win[4];
    dem->read_window(-1, 63, 2, 2, win);  // 3 of 4 pixels outside the grid
    CHECK(std::isnan(win[0]) && std::isnan(win[1]) && win[2] == 0.5f && std::isnan(win[3]));
    dem->read_window(40, 40, 1, 1, win);
    CHECK(std::isnan(win[0]));  // |h| > 100 km -> no-data

    const App a(std::nullopt, dem);
    auto r = a.handle("POST", "/terrain/slope/check", slope_req(-90.0, 0, 200, 1).dump());
    CHECK(r.body["status"] == "computed" && r.body["verdict"] == "pass");
    CHECK(r.body["data_provenance"]["dem_product"] == "TINY_TEST");
    CHECK(r.body["data_provenance"]["dem_sha256"] == std::string(64, 'a'));
    CHECK(r.body["model"]["body_fixed_frame"] == "MEAN EARTH/POLAR AXIS OF DE421");
    // inside the grid but beyond the declared MAXIMUM_LATITUDE (-89.99 deg ~ 303 m from the pole)
    CHECK(*dem->info().max_latitude_deg == -89.99);
    r = a.handle("POST", "/terrain/slope/check", slope_req(-90.0, 0, 400, 1).dump());
    CHECK(r.body["status"] == "out_of_coverage");

    // provenance comes from the label only: a non-LOLA product gets no LOLA URL/licence/caveat
    {
        const json& p = r.body["data_provenance"];
        CHECK(p["data_set_id"] == "TEST" && p["product_version"] == "V0");
        CHECK(p["url"].is_null() && p["license"].is_null() && !p.contains("producer"));
        CHECK(p["producer_id"].is_null() && p["producer_full_name"].is_null() && p["instrument_id"].is_null());
        bool not_recorded = false, gmt = false;
        for (const auto& w : r.body["warnings"]) {
            not_recorded |= w.get<std::string>().find("origin and license are not recorded") != std::string::npos;
            gmt |= w.get<std::string>().find("GMT") != std::string::npos;
        }
        CHECK(not_recorded && !gmt);
    }
    // LOLA GDR label (keywords as in LDEM_85S_20M_FLOAT.LBL): LOLA URL, licence and GMT caveat
    write_label(dir / "tiny.lbl",
                "DATA_SET_ID = \"LRO-L-LOLA-4-GDR-V1.0\"\nINSTRUMENT_HOST_NAME = \"LUNAR RECONNAISSANCE ORBITER\"\n"
                "INSTRUMENT_ID = \"LOLA\"\nPRODUCT_CREATION_TIME = 2017-06-15\nPRODUCER_ID = LRO_LOLA_TEAM\n"
                "PRODUCER_FULL_NAME = \"DAVID E. SMITH\"\nPRODUCER_INSTITUTION_NAME = \"GODDARD SPACE FLIGHT CENTER\"\n");
    {
        auto lola = Dem::open_pds_auto(dir / "tiny.img", std::nullopt);
        CHECK(lola->info().lola_gdr);
        const App al(std::nullopt, lola);
        auto rl = al.handle("POST", "/terrain/slope/check", slope_req(-90.0, 0, 200, 1).dump());
        const json& p = rl.body["data_provenance"];
        CHECK(p["producer_id"] == "LRO_LOLA_TEAM" && p["producer_full_name"] == "DAVID E. SMITH");
        CHECK(p["producer_institution_name"] == "GODDARD SPACE FLIGHT CENTER" && p["instrument_id"] == "LOLA");
        CHECK(p["product_creation_time"] == "2017-06-15");
        CHECK(p["url"].is_string() && p["license"].is_string() && p["producer"].is_string());
        bool not_recorded = false, gmt = false;
        for (const auto& w : rl.body["warnings"]) {
            not_recorded |= w.get<std::string>().find("not recorded") != std::string::npos;
            gmt |= w.get<std::string>().find("GMT") != std::string::npos;
        }
        CHECK(gmt && !not_recorded);
    }
    // No DATA_SET_ID at all, or a LOLA dataset that is not a GDR: label fields only
    write_label(dir / "tiny.lbl", "");
    {
        auto bare = Dem::open_pds_auto(dir / "tiny.img", std::nullopt);
        CHECK(!bare->info().lola_gdr);
        const App ab(std::nullopt, bare);
        auto rb = ab.handle("POST", "/terrain/slope/check", slope_req(-90.0, 0, 200, 1).dump());
        CHECK(rb.body["data_provenance"]["data_set_id"].is_null() && rb.body["data_provenance"]["url"].is_null());
        bool absent = false;
        for (const auto& w : rb.body["warnings"]) absent |= w.get<std::string>().find("DATA_SET_ID absent") != std::string::npos;
        CHECK(absent);
    }
    {
        selene::dem::Label l;
        l.data_set_id = "LRO-L-LOLA-3-RDR-V1.0";
        CHECK(!selene::dem::is_lola_gdr(l));
        l.data_set_id = "XYZ-LRO-L-LOLA-4-GDR";
        CHECK(!selene::dem::is_lola_gdr(l));
        l.data_set_id = "LRO-L-LOLA-4-GDR-V1.0";
        CHECK(selene::dem::is_lola_gdr(l));
    }

    // DEM identity (cache key) changes with the recorded hash, so a swapped file never hits old entries
    {
        const std::string id1 = Dem::open_pds_auto(dir / "tiny.img", std::nullopt)->info().identity;
        std::ofstream(dir / "SHA256SUMS") << std::string(64, 'b') << "  tiny.img\n";
        const std::string id2 = Dem::open_pds_auto(dir / "tiny.img", std::nullopt)->info().identity;
        CHECK(!id1.empty() && id1 != id2);
    }

    // size mismatch is refused at startup, never served
    std::ofstream(dir / "short.img", std::ios::binary) << "1234";
    fs::copy_file(dir / "tiny.lbl", dir / "short.lbl", fs::copy_options::overwrite_existing);
    CHECK_THROWS(Dem::open_pds_auto(dir / "short.img", std::nullopt), std::runtime_error);
    CHECK_THROWS(Dem::open_pds_auto(dir / "missing.img", std::nullopt), std::runtime_error);
    fs::remove_all(dir);
}

// ---------- contracts ----------

static void test_contracts() {
    const fs::path fixtures = CONTRACTS / "fixtures";
    CHECK(post("/evaluate", load(fixtures / "scenario-request.valid.json")).status == 200);

    int n = 0;
    for (const auto& entry : fs::directory_iterator(fixtures / "invalid-requests")) {
        ++n;
        auto r = post("/evaluate", load(entry.path()));
        if (r.status != 422) std::fprintf(stderr, "accepted invalid fixture %s\n", entry.path().string().c_str());
        CHECK(r.status == 422);
    }
    CHECK(n > 0);

    // The committed response fixtures are schema-validated by services/api tests; check that
    // live output still matches them (regenerate with tools/generate_fixtures.cpp if not).
    json request = load(fixtures / "scenario-request.valid.json");
    CHECK(json_near(post("/evaluate", request).body, load(fixtures / "scenario-response.not-ready.json")));
    request["duration_hours"] = 48;
    request["step_minutes"] = 360;
    CHECK(json_near(post("/evaluate/synthetic", request).body,
                    load(fixtures / "scenario-response.synthetic.json")));

    // slope check: no DEM, and the SYNTHETIC tilted-plane DEM (same inputs as generate_fixtures.cpp)
    const json slope = load(fixtures / "slope-check-request.valid.json");
    CHECK(json_near(app.handle("POST", "/terrain/slope/check", slope.dump()).body,
                    load(fixtures / "slope-check-response.dem-unavailable.json")));
    const App tilted(std::nullopt, selene::testing::tilted_plane_dem(8.0));
    CHECK(json_near(tilted.handle("POST", "/terrain/slope/check", selene::testing::synthetic_fixture_request().dump()).body,
                    load(fixtures / "slope-check-response.synthetic-dem.json")));
}

// ---------- robustness: no input may crash the service ----------

// Every response must be one of the documented statuses and serialisable; 200s must be
// internally consistent (finite, in-range directions, increasing timestamps, sane windows).
static void check_response(const HttpResponse& r) {
    CHECK(r.status == 200 || r.status == 404 || r.status == 405 || r.status == 422);
    std::string dumped;
    try {
        dumped = r.body.dump();
    } catch (...) {
        CHECK(!"response is not serialisable");
    }
    if (r.status != 200) {
        CHECK(r.body.contains("error") && !r.body["error"]["details"].is_null());
        return;
    }
    if (r.body.contains("service")) {  // GET /health
        CHECK(r.body["ephemeris"]["ready"].is_boolean());
        return;
    }
    const json& s = r.body.at("samples");
    if (r.body["status"] != "not_ready") {
        CHECK(!s.empty());
        CHECK((long long)s.size() <= MAX_SAMPLES);
    }
    std::string prev;
    for (const auto& x : s) {
        const std::string utc = x["utc"];
        CHECK(utc.size() == 24 && utc > prev);
        prev = utc;
        for (const char* b : {"sun", "earth"}) {
            double a = x[b]["azimuth_deg"], e = x[b]["elevation_deg"];
            CHECK(std::isfinite(a) && std::isfinite(e) && a >= 0 && a < 360 && e >= -90 && e <= 90);
        }
    }
    for (const char* w : {"sun_visible", "earth_visible"})
        for (const auto& win : r.body["windows"][w])
            CHECK(win["start_utc"].get<std::string>() <= win["end_utc"].get<std::string>());
}

static void hit(const std::string& body) {
    for (const char* path : {"/evaluate", "/evaluate/synthetic"}) check_response(app.handle("POST", path, body));
}

static void test_robustness() {
    const json valid = load(CONTRACTS / "fixtures/scenario-request.valid.json");

    // routing: every method x path combination
    for (const char* m : {"GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", ""})
        for (const char* p : {"/health", "/evaluate", "/evaluate/synthetic", "/", "", "/evaluate/",
                              "/health/x", "//evaluate", "/evaluate/synthetic/x"})
            check_response(app.handle(m, p, valid.dump()));

    // boundary grid on every numeric field
    const double inf = INFINITY;
    const std::vector<double> specials = {0.0, -0.0, 1e-308, -1e-308, 5e-324, 1e308, -1e308, inf, -inf};
    auto around = [&](std::vector<double> v, std::initializer_list<double> limits) {
        for (double l : limits) {
            v.push_back(l);
            v.push_back(std::nextafter(l, inf));
            v.push_back(std::nextafter(l, -inf));
        }
        return v;
    };
    const std::vector<double> lat = around(specials, {-90, 90, -89, 89}),
                              lon = around(specials, {-180, 180}),
                              h = around(specials, {0, 1000}),
                              dur = around(specials, {0, 2160, 1, 1.0 / 60}),
                              step = around(specials, {1, 1440, 2160.0 * 60 / 19999});
    for (double x : lat) { json b = valid; b["site"]["latitude_deg"] = x; hit(b.dump()); }
    for (double x : lon) { json b = valid; b["site"]["longitude_deg"] = x; hit(b.dump()); }
    for (double x : h) { json b = valid; b["site"]["observer_height_m"] = x; hit(b.dump()); }
    for (double d : dur)
        for (double s : step) {
            json b = valid;
            b["duration_hours"] = d;
            b["step_minutes"] = s;
            hit(b.dump());
        }

    // exactly MAX_SAMPLES is accepted, one more is not
    {
        json b = valid;
        b["step_minutes"] = 6;
        b["duration_hours"] = 1999.9001;  // floor(1999.9001 * 60 / 6) + 1 = 20000 samples
        auto r = post("/evaluate/synthetic", b);
        CHECK(r.status == 200 && (long long)r.body["samples"].size() == MAX_SAMPLES);
        check_response(r);
        b["duration_hours"] = 2000;  // 20001 samples
        CHECK(post("/evaluate/synthetic", b).status == 422);
    }

    // extreme dates: first/last representable instants, leap days, grids crossing year 9999
    for (const char* t : {"0001-01-01T00:00:00Z", "9999-12-31T23:59:59.999999Z", "9999-12-31T23:59:59Z",
                          "9999-09-01T00:00:00Z", "2000-02-29T00:00:00Z", "1900-02-29T00:00:00Z",
                          "1969-12-31T23:59:59.9999999999Z", "2026-11-15T00:00:00.Z", "2026-11-15T00:00:00",
                          "2026-11-15T00:00:00Z\n", "\n2026-11-15T00:00:00Z", "2026-11-15t00:00:00z",
                          "２026-11-15T00:00:00Z", "2026-11-15T00:00:00ZZ", "99999-01-01T00:00:00Z", "",
                          "-001-01-01T00:00:00Z", "2026-00-00T00:00:00Z", "2026-11-15T99:99:99Z"}) {
        json b = valid;
        b["start_utc"] = t;
        b["duration_hours"] = 2160;
        b["step_minutes"] = 1440;
        hit(b.dump());
    }
    {
        json b = valid;
        b["start_utc"] = "9999-12-31T23:00:00Z";
        b["duration_hours"] = 2;
        CHECK(post("/evaluate/synthetic", b).status == 422);
        b["duration_hours"] = 0.5;
        CHECK(post("/evaluate/synthetic", b).status == 200);
    }

    // pathological strings and JSON documents
    for (size_t n : {size_t(10), size_t(1000), size_t(100000), size_t(1000000)}) {
        json b = valid;
        b["start_utc"] = "2026-11-15T00:00:00." + std::string(n, '7') + "Z";
        hit(b.dump());
        b["start_utc"] = std::string(n, '9');
        hit(b.dump());
        b = valid;
        b[std::string(n, 'k')] = 1;
        hit(b.dump());
        hit(std::string(n, '['));
        hit(std::string(n, '[') + std::string(n, ']'));
        hit("{\"site\":" + std::string(n, '[') + std::string(n, ']') + "}");
        hit(std::string(n, '{'));
        hit("\"" + std::string(n, 'a') + "\"");
    }
    for (const char* raw : {"", " ", "null", "true", "0", "-0", "1e400", "-1e400", "[]", "{}", "\"\"",
                            "{\"site\":null}", "{\"site\":{}}", "{\"site\":[]}", "\xff\xfe", "{\"\xff\":1}",
                            "{\"a\":\"\\ud800\"}", "{\"start_utc\":\"\\u0000\"}", "\0", "{\"site\":1e400}",
                            "{\"duration_hours\":1e400,\"step_minutes\":-1e400}", "{\"duration_hours\":99999999999999999999999999}",
                            "{\"duration_hours\":-9223372036854775809,\"step_minutes\":18446744073709551616}",
                            "{\"site\":{\"latitude_deg\":0,\"latitude_deg\":1}}", "{,}", "{\"a\":1,}", "[1,2", "/*x*/{}"})
        hit(raw);

    // random mutations of a valid request (fixed seed: reproducible)
    uint64_t seed = 0x5e1e7e;
    auto rnd = [&seed](uint64_t n) {
        seed ^= seed << 13, seed ^= seed >> 7, seed ^= seed << 17;
        return n ? seed % n : 0;
    };
    const std::vector<json> pool = {nullptr, true, false, 0, -1, 1, 0.5, -0.0, 1e308, -1e308, 89.999, -180, 180,
                                    2160, 1440, 20000, "ideal", "dem", "", "x", "2026-11-15T00:00:00Z",
                                    json::array(), json::object(), json::array({1, 2}), json{{"a", 1}}};
    const std::vector<std::string> keys = {"site", "start_utc", "duration_hours", "step_minutes", "terrain_mode", "extra"};
    const std::vector<std::string> site_keys = {"latitude_deg", "longitude_deg", "observer_height_m", "z"};
    const std::string alphabet = "0123456789-T:.Z+ z\x01\xc3\xa9";
    for (int it = 0; it < 20000; ++it) {
        json b = valid;
        b["duration_hours"] = 6;  // short base grid keeps the sanitizer run fast; mutations still vary it
        for (uint64_t k = 0, n = 1 + rnd(4); k < n; ++k) {
            switch (rnd(7)) {
                case 0: b[keys[rnd(keys.size())]] = pool[rnd(pool.size())]; break;
                case 1: b.erase(keys[rnd(keys.size())]); break;
                case 2:
                    if (b["site"].is_object()) b["site"][site_keys[rnd(site_keys.size())]] = pool[rnd(pool.size())];
                    break;
                case 3:
                    if (b["site"].is_object()) b["site"].erase(site_keys[rnd(site_keys.size())]);
                    break;
                case 4: {
                    std::string s = "2026-11-15T00:00:00Z";
                    for (uint64_t j = 0, m = 1 + rnd(4); j < m; ++j)
                        s[rnd(s.size())] = alphabet[rnd(alphabet.size())];
                    if (rnd(2)) s.resize(rnd(s.size() + 1));
                    b["start_utc"] = s;
                    break;
                }
                case 5:  // long grids are covered by the boundary grid above; keep most short
                    b["duration_hours"] = (double)rnd(rnd(20) ? 48000 : 2200000) / 1000.0;
                    break;
                default: b["step_minutes"] = 1 + (double)rnd(1500000) / 1000.0; break;
            }
        }
        std::string body;
        try {
            body = b.dump();
        } catch (...) {
            continue;  // random bytes may not be valid UTF-8; not a request a client can send as JSON
        }
        if (rnd(10) == 0 && !body.empty()) body.resize(rnd(body.size()));  // truncated body
        hit(body);
    }
    // random raw bytes
    for (int it = 0; it < 5000; ++it) {
        std::string s(rnd(64), '\0');
        for (char& c : s) c = static_cast<char>(rnd(256));
        hit(s);
    }
}

// SLDEM2015-like simple cylindrical tiles (64 px/deg, 58-60 N) on disk: label checks, mosaic across
// the 0/360 seam, missing tile, anisotropic Horn spacing (cos lat), and slope_check_any ordering.
static void test_cylindrical_mosaic() {
    const fs::path dir = fs::temp_directory_path() / "selene-sldem-test";
    fs::remove_all(dir);
    fs::create_directories(dir);
    const int ppd = 64, n = 128;  // 2 x 2 deg tiles
    const double R = 1737400.0, top = 60.0, gtan = std::tan(8.0 / 57.29577951308232);
    // z = gtan * eastward ground distance from lon 0: a plane sloping 8 deg toward east everywhere.
    auto write_tile = [&](double west, const std::string& center_lon = "180.") {
        char name[96];
        std::snprintf(name, sizeof name, "sldem2015_64_58n_60n_%03d_%03d_float", static_cast<int>(west), static_cast<int>(west) + 2);
        std::vector<float> h(static_cast<std::size_t>(n) * n);
        for (int l = 0; l < n; ++l)
            for (int s = 0; s < n; ++s) {
                const double lat = top - (l + 0.5) / ppd;
                double lon = west + (s + 0.5) / ppd;
                if (lon > 180) lon -= 360;
                h[static_cast<std::size_t>(l) * n + s] =
                    static_cast<float>(gtan * R * std::cos(lat / 57.29577951308232) * lon / 57.29577951308232 / 1000.0);
            }
        std::ofstream(dir / (std::string(name) + ".img"), std::ios::binary)
            .write(reinterpret_cast<const char*>(h.data()), static_cast<std::streamsize>(h.size() * 4));
        std::ofstream(dir / (std::string(name) + ".lbl"))
            << "PRODUCT_ID = \"" << name << "\"\nDATA_SET_ID = \"LRO-L-LOLA-4-GDR-V1.0\"\nRECORD_BYTES = " << n * 4
            << "\nLINES = " << n << "\nLINE_SAMPLES = " << n
            << "\nSAMPLE_TYPE = PC_REAL\nUNIT = KILOMETER\nSCALING_FACTOR = 1\nOFFSET = 1737.4\n"
               "MAP_PROJECTION_TYPE = \"SIMPLE CYLINDRICAL\"\nMAP_RESOLUTION = 64 <pix/deg>\n"
               "A_AXIS_RADIUS = 1737.4 <km>\nB_AXIS_RADIUS = 1737.4 <km>\nC_AXIS_RADIUS = 1737.4 <km>\n"
               "CENTER_LATITUDE = 0. <deg>\nCENTER_LONGITUDE = " << center_lon << " <deg>\nMAP_PROJECTION_ROTATION = 0.0\n"
               "MAP_SCALE = 0.473802 <km/pix>\nMAXIMUM_LATITUDE = 60 <deg>\nMINIMUM_LATITUDE = 58 <deg>\n"
               "WESTERNMOST_LONGITUDE = " << west << " <deg>\nEASTERNMOST_LONGITUDE = " << west + 2 << " <deg>\n"
               "LINE_PROJECTION_OFFSET = " << top * ppd - 0.5 << " <pix>\nSAMPLE_PROJECTION_OFFSET = "
            << -0.5 - (west - 180.0) * ppd << " <pix>\nCOORDINATE_SYSTEM_NAME = \"MEAN EARTH/POLAR AXIS OF DE421\"\nEND\n";
    };
    write_tile(0);
    write_tile(358);
    const auto mosaic = Dem::open_sldem_dir(dir);
    const DemInfo& d = mosaic->info();
    CHECK(d.grid == DemGrid::cylindrical && d.wraps_lon && d.ppd == 64 && d.lines == 128 && d.samples == 360 * 64);
    CHECK_NEAR(d.proj.scale_m, 473.802, 1e-6);  // <km/pix> converted to metres
    CHECK(*d.max_latitude_deg == 60 && *d.min_latitude_deg == 58);
    // pixel <-> lat/lon round trip, including a negative longitude (west of the seam)
    const GridPos gp = dem_pixel_of(d, 59.3, -0.7);
    CHECK_NEAR(gp.line, (60 - 59.3) * 64 - 0.5, 1e-9);
    CHECK_NEAR(gp.sample, 359.3 * 64 - 0.5, 1e-9);
    const LatLon back = dem_latlon_of(d, gp.line, gp.sample);
    CHECK_NEAR(back.lat_deg, 59.3, 1e-9);
    CHECK_NEAR(back.lon_deg, -0.7, 1e-9);
    CHECK(mosaic->covers(10, 5) && mosaic->covers(10, 360 * 64 - 5) && mosaic->covers(10, -5) && !mosaic->covers(10, 200));

    // Zone straddling the 0/360 seam, both tiles installed: east-west plane of 8 deg read correctly
    // only if the east-west spacing carries cos(lat) (else ~4 deg at 59 N).
    json r = check_on(mosaic, slope_req(59.0, 0.0, 8000, 9));
    CHECK(r["status"] == "computed" && r["verdict"] == "pass");
    CHECK_NEAR(r["stats"]["slope_mean_deg"].get<double>(), 8.0, 0.05);
    CHECK_NEAR(r["stats"]["slope_max_deg"].get<double>(), 8.0, 0.05);
    CHECK(r["model"]["projection"].get<std::string>().find("simple cylindrical") != std::string::npos);
    // Zone reaching into lon 2-4 deg, whose tile is not installed: never a partial verdict.
    r = check_on(mosaic, slope_req(59.0, 1.95, 8000, 9));
    CHECK(r["status"] == "out_of_coverage");
    // North of the declared MAXIMUM_LATITUDE
    r = check_on(mosaic, slope_req(59.97, 1.0, 5000, 9));
    CHECK(r["status"] == "out_of_coverage");

    // slope_check_any: finest first; the south synthetic DEM does not cover 59 N, the mosaic does.
    const auto south = selene::testing::tilted_plane_dem(3.0);
    r = slope_check_any(parse_slope_check_request(slope_req(59.0, 0.0, 8000, 9)), {south.get(), mosaic.get()}, "x");
    CHECK(r["status"] == "computed" && r["data_provenance"]["dem_product"] == "SLDEM2015_64 mosaic");
    r = slope_check_any(parse_slope_check_request(slope_req(-89.99, 0.0, 300, 9)), {south.get(), mosaic.get()}, "x");
    CHECK(r["status"] == "computed" && r["data_provenance"]["dem_product"] == "SYNTHETIC_TILTED_PLANE");
    r = slope_check_any(parse_slope_check_request(slope_req(10.0, 10.0, 2000, 9)), {south.get(), mosaic.get()}, "x");
    CHECK(r["status"] == "out_of_coverage");
    CHECK(r["warnings"].back().get<std::string>().find("No installed slope DEM covers") != std::string::npos);
    r = slope_check_any(parse_slope_check_request(slope_req(10.0, 10.0, 2000, 9)), {}, "nothing installed");
    CHECK(r["status"] == "dem_unavailable");
    // App: SELENE_DEM_PATH DEM first, then the extra slope DEMs
    const App a(std::nullopt, south, "", {mosaic});
    CHECK(a.handle("POST", "/terrain/slope/check", slope_req(59.0, 0.0, 8000, 9).dump()).body["status"] == "computed");

    // A label whose offsets break the pixel-registered convention is refused, not guessed.
    write_tile(0, "170.");
    bool threw = false;
    try {
        Dem::open_sldem_dir(dir);
    } catch (const std::runtime_error&) {
        threw = true;
    }
    CHECK(threw);
    fs::remove_all(dir);
}

// North polar stereographic grid: pixel <-> lat/lon round trip, lon 0 pointing down the image.
static void test_north_polar_grid() {
    DemInfo d = selene::testing::synthetic_info("SYNTHETIC_NORTH");
    d.grid = DemGrid::polar_north;
    d.proj.sign_y = -1;
    d.min_latitude_deg = 89.9;
    const GridPos p = dem_pixel_of(d, 89.95, 37.0);
    const LatLon b = dem_latlon_of(d, p.line, p.sample);
    CHECK_NEAR(b.lat_deg, 89.95, 1e-9);
    CHECK_NEAR(b.lon_deg, 37.0, 1e-9);
    CHECK(dem_pixel_of(d, 89.99, 0.0).line > selene::testing::SYN_POLE);    // lon 0: down
    CHECK(dem_pixel_of(d, 89.99, 90.0).sample > selene::testing::SYN_POLE);  // lon 90 E: right
    const auto flat = Dem::in_memory(d, std::vector<float>(static_cast<std::size_t>(d.lines) * d.samples, 0.f));
    json r = check_on(flat, slope_req(89.99, 0.0, 300, 1));
    CHECK(r["status"] == "computed" && r["verdict"] == "pass");
    CHECK(r["model"]["projection"].get<std::string>().find("90N") != std::string::npos);
    r = check_on(flat, slope_req(89.99, 0.0, 2000, 1));  // reaches south of MINIMUM_LATITUDE 89.9
    CHECK(r["status"] == "out_of_coverage");
    CHECK(check_on(flat, slope_req(-89.99, 0.0, 300, 1))["status"] == "out_of_coverage");
}

int main() {
    test_geometry();
    test_enu_basis();
    test_intervals();
    test_link();
    test_lunar_ephemeris();
    test_radio_link();
    test_terrain_horizon();
    test_evaluate_with_terrain();
    test_celestial_state_without_kernels();
    test_time();
    test_api();
    test_slope_check();
    test_slope_cache();
    test_dem_file();
    test_cylindrical_mosaic();
    test_north_polar_grid();
    test_contracts();
    test_robustness();
    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
