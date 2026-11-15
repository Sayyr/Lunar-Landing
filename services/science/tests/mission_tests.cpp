// Unit tests for the mission simulation (src/mission.hpp): energy balance, span helpers, request
// parsing, and full runs on the SYNTHETIC ephemeris provider (no kernels, no DEM needed).

#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>

#include "app.hpp"
#include "synthetic_dem.hpp"

#include "mission.hpp"

using namespace selene;

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

static PowerParams power(double area = 1, double load = 100, double cap = 1000, double soc = 1) {
    PowerParams p;
    p.panel_area_m2 = area;
    p.panel_efficiency = 0.25;
    p.pointing = PanelPointing::SunTracking;
    p.load_w = load;
    p.battery_capacity_wh = cap;
    p.battery_initial_soc = soc;
    p.charge_efficiency = 1;
    p.discharge_efficiency = 1;
    return p;
}

static void test_solar_power() {
    PowerParams p = power(2);
    CHECK_NEAR(solar_power_w(p, 30, true), SOLAR_CONSTANT_W_M2 * 2 * 0.25, 1e-9);
    CHECK(solar_power_w(p, 30, false) == 0.0);
    p.pointing = PanelPointing::Vertical;
    CHECK_NEAR(solar_power_w(p, 60, true), SOLAR_CONSTANT_W_M2 * 0.5 * 0.5, 1e-9);
    p.pointing = PanelPointing::Horizontal;
    CHECK_NEAR(solar_power_w(p, 30, true), SOLAR_CONSTANT_W_M2 * 0.5 * 0.5, 1e-9);
    CHECK(solar_power_w(p, -1, true) == 0.0);  // below the panel plane
}

static void test_energy_balance() {
    // 11 hourly samples; Sun for the first 5 h then night.
    std::vector<double> t, el;
    std::vector<bool> vis;
    for (int i = 0; i <= 10; ++i) {
        t.push_back(i * 3600.0);
        el.push_back(10);
        vis.push_back(i <= 4);
    }
    PowerParams p = power(1, 100, 1000, 0.5);  // 340.25 W in Sun, 100 W load
    const double sun_w = SOLAR_CONSTANT_W_M2 * 0.25;
    EnergyResult r = simulate_energy(t, el, vis, p, 500, 200);
    // Hours 0-4: +240.25 W -> 500 + 4 * 240.25 = 1461 > 1000: curtailed.
    CHECK_NEAR(r.battery_wh[2], 980.5, 1e-9);
    CHECK_NEAR(r.battery_wh[4], 1000, 1e-9);
    CHECK_NEAR(r.curtailed_wh, 4 * (sun_w - 100) + (sun_w / 2 - 100) - 500, 1e-6);  // incl. hour 4-5
    // Hour 4-5: trapezoid (sun_w + 0) / 2 - 100 = +70.1 W, but battery full -> curtailed more.
    CHECK_NEAR(r.battery_wh[5], 1000, 1e-9);
    // Then -100 W per hour: 900, 800, ... 500 at sample 10.
    CHECK_NEAR(r.battery_wh[10], 500, 1e-6);
    CHECK_NEAR(r.generated_wh, 4 * sun_w + sun_w / 2, 1e-6);
    CHECK_NEAR(r.load_wh, 1000, 1e-9);
    CHECK(r.unserved_wh == 0.0);
    CHECK(!r.first_below_reserve);
    // Higher reserve: crossed at the first sample below 600 Wh (sample 10: 500).
    r = simulate_energy(t, el, vis, p, 500, 600);
    CHECK(r.first_below_reserve && *r.first_below_reserve == 0);  // 500 < 600 already at landing
    // Night only with a small battery: unserved load, battery floor at 0.
    std::vector<bool> dark(t.size(), false);
    r = simulate_energy(t, el, dark, power(1, 100, 300, 1), 300, 0);
    CHECK_NEAR(r.battery_wh[3], 0, 1e-9);
    CHECK_NEAR(r.unserved_wh, 700, 1e-6);
    CHECK(r.min_index == 3);
    // Efficiencies: discharge 0.5 doubles the drain.
    PowerParams q = power(1, 100, 1000, 1);
    q.discharge_efficiency = 0.5;
    r = simulate_energy(t, el, dark, q, 1000, 0);
    CHECK_NEAR(r.battery_wh[1], 800, 1e-9);
}

static void test_spans() {
    std::vector<Interval> a{{0, 10, true, false}, {20, 30, false, false}}, b{{5, 25, false, false}};
    auto x = intersect(a, b);
    CHECK(x.size() == 2 && x[0].start == 5 && x[0].end == 10 && x[1].start == 20 && x[1].end == 25);
    CHECK(total_seconds(a) == 20);
    CHECK(longest_gap_seconds(a, 50) == 20);  // 30 -> 50
    CHECK(longest_gap_seconds({}, 50) == 50);
    CHECK(covered(a, 25) && !covered(a, 15));
    PowerParams p = power(1, 100, 1000, 0.8);
    CHECK_NEAR(battery_at_landing_wh(p, 10, std::nullopt), 800, 1e-9);
    CHECK_NEAR(battery_at_landing_wh(p, 10, 50.0), 300, 1e-9);
    CHECK(battery_at_landing_wh(p, 100, 50.0) == 0.0);
}

static json valid_body() {
    return json::parse(R"({
      "site": {"latitude_deg": -89.5, "longitude_deg": 0, "observer_height_m": 2},
      "landing_utc": "2026-11-15T00:00:00Z", "surface_hours": 72, "step_minutes": 30, "terrain_mode": "ideal",
      "power": {"panel_area_m2": 2, "panel_efficiency": 0.28, "panel_pointing": "vertical", "load_w": 150,
                "battery_capacity_wh": 3000, "battery_initial_soc": 0.9, "charge_efficiency": 0.95, "discharge_efficiency": 0.95},
      "constraints": {"min_battery_soc": 0.2, "max_earth_outage_hours": null, "min_contact_hours": null,
                      "min_data_volume_mbit": 10, "max_slope_deg": 10, "min_slope_ok_fraction": null}
    })");
}

static bool has_error(const ValidationError& e, const std::string& field) {
    for (const auto& d : e.details)
        if (d.field == field) return true;
    return false;
}

static void test_parse() {
    MissionRequest r = parse_mission_request(valid_body());
    CHECK(r.surface_hours == 72 && r.landing_delay_hours == 0 && r.end_policy == "fixed_duration");
    CHECK(r.power->pointing == PanelPointing::Vertical && !r.radio && r.constraints.min_data_volume_mbit == 10.0);
    CHECK(!r.constraints.max_earth_outage_hours && r.search_step_hours == 6);
    CHECK(to_json(r)["request"].is_null());  // echo has no nested "request"
    CHECK(to_json(r)["delay"]["end_policy"] == "fixed_duration");

    json b = valid_body();
    b["landing_utc"] = "2026-13-01T00:00:00Z";
    b["surface_hours"] = -1;
    b["power"]["panel_pointing"] = "diagonal";
    b["constraints"].erase("max_slope_deg");
    b["delay"] = {{"landing_delay_hours", 1000}, {"end_policy", "later"}};
    b["radio"] = {{"min_earth_elevation_deg", 5}, {"link", json::object()}, {"stations", json::array()}};
    b["extra"] = 1;
    try {
        parse_mission_request(b);
        CHECK(false);
    } catch (const ValidationError& e) {
        CHECK(has_error(e, "landing_utc"));
        CHECK(has_error(e, "surface_hours"));
        CHECK(has_error(e, "power.panel_pointing"));
        CHECK(has_error(e, "constraints.max_slope_deg"));
        CHECK(has_error(e, "delay.landing_delay_hours"));
        CHECK(has_error(e, "delay.end_policy"));
        CHECK(has_error(e, "radio.link.frequency_hz"));
        CHECK(has_error(e, "radio.stations"));
        CHECK(has_error(e, "extra"));
    }
    b = valid_body();
    b["search"] = {{"max_extra_delay_hours", 720}, {"step_hours", 0.5}};
    try {
        parse_mission_request(b);
        CHECK(false);
    } catch (const ValidationError& e) {
        CHECK(has_error(e, "search"));
    }
}

// Test provider whose Sun depends on ABSOLUTE time (24 h cycle: up from 00:00 to 12:00 UTC), Earth
// always up. Unlike the synthetic provider, landing dates then differ.
class DailySunProvider : public EphemerisProvider {
public:
    std::string kind() const override { return "test_daily_sun"; }
    bool synthetic() const override { return true; }
    ProviderStatus status() const override { return {true, ""}; }
    json model_info() const override { return {{"ephemeris_provider", "test_daily_sun"}, {"horizon_model", "ideal_geometric"}}; }
    json provenance() const override { return json::array(); }
    std::vector<std::string> assumptions() const override { return {"TEST provider"}; }
    DirectionSeries directions(const Site&, const std::vector<int64_t>& t) const override {
        DirectionSeries d;
        for (int64_t us : t) {
            const double h = std::fmod(static_cast<double>(us) / 3600e6, 24.0);
            d.sun_azimuth_deg.push_back(90);
            d.sun_elevation_deg.push_back(10 * std::sin(h / 24 * 2 * 3.14159265358979323846));
            d.earth_azimuth_deg.push_back(0);
            d.earth_elevation_deg.push_back(5);
        }
        return d;
    }
};

static void test_slope_fixes();

static void test_date_scan() {
    DailySunProvider daily;
    MissionContext ctx;
    ctx.provider = &daily;
    // 6 h stay, tiny battery, reserve 20 %: passes only if the whole stay is in sunlight (00:00-12:00 UTC).
    json d = valid_body();
    d["landing_utc"] = "2026-11-15T09:00:00Z";  // stay 09:00-15:00 crosses sunset at 12:00 -> no_go
    d["surface_hours"] = 6;
    d["power"]["panel_pointing"] = "sun_tracking";
    d["power"]["battery_capacity_wh"] = 100;
    d["power"]["load_w"] = 150;
    d["constraints"] = {{"min_battery_soc", 0.2}, {"max_earth_outage_hours", nullptr}, {"min_contact_hours", nullptr},
                        {"min_data_volume_mbit", nullptr}, {"max_slope_deg", nullptr}, {"min_slope_ok_fraction", nullptr}};
    d["search"] = {{"max_extra_delay_hours", 24}, {"step_hours", 3}};
    json o = simulate_mission(parse_mission_request(d), ctx);
    CHECK(o["verdict"] == "no_go");
    CHECK(o["date_scan"].is_object());
    const json& pts = o["date_scan"]["points"];
    CHECK(pts.size() == 17);  // -24 .. +24 h every 3 h
    CHECK(pts[0]["offset_hours"] == -24.0 && pts[8]["offset_hours"] == 0.0 && pts[16]["offset_hours"] == 24.0);
    CHECK(pts[8]["verdict"] == "no_go" && pts[8]["failed"][0] == "battery_reserve");
    CHECK(o["date_scan"]["ignored_constraints"].empty());
    for (const auto& c : o["corrections"]) CHECK(c.contains("site") && c.contains("max_slope_deg"));
    // 06:00 landing (offset -3 h) keeps the stay in sunlight (06:00-12:00): the nearest passing date.
    bool found = false;
    for (const auto& c : o["corrections"])
        if (c["kind"] == "change_date") {
            found = true;
            CHECK(c["feasible"] == true);
            CHECK(c["landing_utc"] == "2026-11-15T06:00:00.000Z");
            json d2 = d;
            d2["landing_utc"] = c["landing_utc"];
            CHECK(simulate_mission(parse_mission_request(d2), ctx)["verdict"] == "go");
        }
    CHECK(found);
    // A go mission carries no scan.
    json g = d;
    g["landing_utc"] = "2026-11-15T03:00:00Z";
    json og = simulate_mission(parse_mission_request(g), ctx);
    CHECK(og["verdict"] == "go" && og["date_scan"].is_null());
}

static void test_full_synthetic() {
    SyntheticEphemerisProvider synth;
    MissionContext ctx;
    ctx.provider = &synth;
    ctx.slope_unavailable_reason = "test: no DEM";

    json out = simulate_mission(parse_mission_request(valid_body()), ctx);
    CHECK(out["status"] == "synthetic" && out["synthetic"] == true);
    CHECK(out["timeline"].size() == 145);  // 72 h / 30 min + 1
    CHECK(out["inventory"]["surface_hours"] == 72.0);
    CHECK(out["model"]["radio_model"].is_null());
    // No radio -> data volume not evaluated; no DEM -> slope not evaluated.
    bool data_ne = false, slope_ne = false;
    for (const auto& c : out["constraints"]) {
        data_ne |= c["id"] == "data_volume" && c["status"] == "not_evaluated";
        slope_ne |= c["id"] == "landing_slope" && c["status"] == "not_evaluated";
    }
    CHECK(data_ne && slope_ne);
    CHECK(out["verdict"] != "go");
    for (const auto& s : out["timeline"]) CHECK(s["soc"].get<double>() >= 0 && s["soc"].get<double>() <= 1);

    // Delay with fixed end longer than the stay: no surface time, no_go, abort first, no retime.
    json b = valid_body();
    b["delay"] = {{"landing_delay_hours", 100}, {"end_policy", "fixed_end"}, {"pre_landing_net_load_w", nullptr}};
    out = simulate_mission(parse_mission_request(b), ctx);
    CHECK(out["verdict"] == "no_go" && out["inventory"].is_null() && out["timeline"].empty());
    CHECK(out["corrections"][0]["kind"] == "abort");
    CHECK(out["corrections"][1]["kind"] == "retime_landing" && out["corrections"][1]["feasible"] == false);
    CHECK(out["pre_landing"]["landing_utc"] == "2026-11-19T04:00:00.000Z");

    // Delay with a pre-landing draw: SoC at landing reduced exactly.
    b = valid_body();
    b["delay"] = {{"landing_delay_hours", 10}, {"end_policy", "fixed_duration"}, {"pre_landing_net_load_w", 57}};
    out = simulate_mission(parse_mission_request(b), ctx);
    CHECK_NEAR(out["pre_landing"]["soc_at_landing"].get<double>(), (0.9 * 3000 - 57 * 10 / 0.95) / 3000, 1e-12);
    CHECK(out["pre_landing"]["energy_wh"] == 570.0);
    CHECK(out["inventory"]["surface_hours"] == 72.0);

    // Power is optional: without it, no energy figures, the reserve is not evaluated, the rest still runs.
    b = valid_body();
    b.erase("power");
    MissionRequest np = parse_mission_request(b);
    CHECK(!np.power);
    out = simulate_mission(np, ctx);
    CHECK(out["request"]["power"].is_null() && out["model"]["energy_model"].is_null());
    CHECK(out["inventory"]["sizing"].is_null() && out["inventory"]["energy"]["generated_wh"].is_null());
    CHECK(out["inventory"]["energy"]["sun_hours"].is_number());
    CHECK(out["timeline"][0]["soc"].is_null() && out["timeline"][0]["solar_w"].is_null());
    CHECK(out["pre_landing"]["soc_at_landing"].is_null());
    bool reserve_ne = false;
    for (const auto& c : out["constraints"]) reserve_ne |= c["id"] == "battery_reserve" && c["status"] == "not_evaluated";
    CHECK(reserve_ne);
    b["power"] = nullptr;  // explicit null is accepted too
    CHECK(!parse_mission_request(b).power);
    b["power"] = 3;
    try {
        parse_mission_request(b);
        CHECK(false);
    } catch (const ValidationError& e) {
        CHECK(has_error(e, "power"));
    }

    // A battery that is too small with the default reserve: no_go with abort + sizing options, and the
    // suggested battery really passes the battery constraint when re-simulated.
    b = valid_body();
    b["constraints"]["min_data_volume_mbit"] = nullptr;
    b["constraints"]["max_slope_deg"] = nullptr;
    b["power"]["battery_capacity_wh"] = 50;
    b["power"]["panel_area_m2"] = 0.2;
    out = simulate_mission(parse_mission_request(b), ctx);
    CHECK(out["verdict"] == "no_go");
    bool resized = false;
    for (const auto& c : out["corrections"])
        if (c["kind"] == "resize_battery" && c["feasible"] == true) {
            resized = true;
            json b2 = b;
            b2["power"]["battery_capacity_wh"] = c["battery_capacity_wh"];
            CHECK(simulate_mission(parse_mission_request(b2), ctx)["verdict"] == "go");
        }
    CHECK(resized);
}

// Every contract fixture under invalid-mission-simulate-requests/ is a 422 from the service.
static void test_invalid_fixtures() {
    const App app(std::nullopt);
    const std::filesystem::path dir = std::filesystem::path(SELENE_CONTRACTS_DIR) / "fixtures/invalid-mission-simulate-requests";
    int n = 0;
    for (const auto& f : std::filesystem::directory_iterator(dir)) {
        std::ifstream in(f.path());
        const std::string body((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        const HttpResponse r = app.handle("POST", "/mission/simulate/synthetic", body);
        if (r.status != 422) std::fprintf(stderr, "accepted: %s\n", f.path().filename().c_str());
        CHECK(r.status == 422);
        ++n;
    }
    CHECK(n >= 20);
    std::ifstream in(std::filesystem::path(SELENE_CONTRACTS_DIR) / "fixtures/mission-simulate-request.valid.json");
    const std::string body((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    CHECK(app.handle("POST", "/mission/simulate/synthetic", body).status == 200);
}

// Slope fails at the site, nothing time-dependent fails: no date scan, the site/slope fixes instead.
// SYNTHETIC DEM: 40 km square at 100 m, an 8 deg slope west of the pole meridian plane (right < 0), flat east.
static void test_slope_fixes() {
    const double g = std::tan(8.0 * 3.14159265358979323846 / 180.0);
    auto dem = selene::testing::square_dem("SYNTHETIC_HALF_SLOPE", 401, 100.0,
                                           [g](double right, double) { return right < 0 ? g * right : 0.0; });
    DailySunProvider daily;
    MissionContext ctx;
    ctx.provider = &daily;
    ctx.slope_dems = {dem.get()};
    json d = valid_body();
    d.erase("power");
    d["landing_utc"] = "2026-11-15T01:00:00Z";
    d["surface_hours"] = 6;
    d["site"] = {{"latitude_deg", -89.9}, {"longitude_deg", 0.0}, {"observer_height_m", 2}};  // ~3 km from the pole
    d["constraints"] = {{"min_battery_soc", nullptr}, {"max_earth_outage_hours", nullptr}, {"min_contact_hours", nullptr},
                        {"min_data_volume_mbit", nullptr}, {"max_slope_deg", 5}, {"min_slope_ok_fraction", 0.95}};
    json o = simulate_mission(parse_mission_request(d), ctx);
    CHECK(o["verdict"] == "no_go");
    CHECK(o["date_scan"].is_null());  // only the slope fails: dates are fine
    bool moved = false, relaxed = false;
    for (const auto& c : o["corrections"]) {
        if (c["kind"] == "change_date") CHECK(c["feasible"] == false);
        if (c["kind"] == "move_site") {
            moved = true;
            CHECK(c["feasible"] == true && c["verdict"] == "go" && c["site"].is_object());
            json d2 = d;  // the proposed site really passes
            d2["site"]["latitude_deg"] = c["site"]["latitude_deg"];
            d2["site"]["longitude_deg"] = c["site"]["longitude_deg"];
            CHECK(simulate_mission(parse_mission_request(d2), ctx)["verdict"] == "go");
        }
        if (c["kind"] == "relax_slope") {
            relaxed = true;
            const double lim = c["max_slope_deg"].get<double>();
            CHECK(lim >= 8.0 && lim <= 8.3);  // the plane's 8 deg (+ rounding up to 0.1 deg)
            CHECK(c["verdict"] == "go");
        }
    }
    CHECK(moved && relaxed);
}

int main() {
    test_invalid_fixtures();
    test_solar_power();
    test_energy_balance();
    test_spans();
    test_parse();
    test_full_synthetic();
    test_date_scan();
    test_slope_fixes();
    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
