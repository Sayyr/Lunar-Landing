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
#include "evaluate.hpp"
#include "geometry.hpp"
#include "intervals.hpp"
#include "models.hpp"

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
}

int main() {
    test_geometry();
    test_intervals();
    test_time();
    test_api();
    test_contracts();
    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
