// Unit, API and contract tests for the science service. Run via `ctest` or directly.
// Ported from the former Python test suite (services/sciencepy/tests).

#include <cmath>
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
#include "intervals.hpp"
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
    CHECK(r.body["ephemeris"]["reason"].get<std::string>().find("not implemented") != std::string::npos);

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
    r = post("/evaluate/synthetic", dem);
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

int main() {
    test_geometry();
    test_intervals();
    test_time();
    test_api();
    test_slope_check();
    test_slope_cache();
    test_dem_file();
    test_contracts();
    test_robustness();
    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
