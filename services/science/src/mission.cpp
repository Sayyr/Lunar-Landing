#include "mission.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <functional>

namespace selene {

using namespace validate;

namespace {

constexpr double DEG_RAD = 3.14159265358979323846 / 180.0;
constexpr int MAX_SEARCH_POINTS = 120;

std::string fmt(const char* f, double a) {
    char b[160];
    std::snprintf(b, sizeof b, f, a);
    return b;
}
std::string fmt2(const char* f, double a, double b2) {
    char b[200];
    std::snprintf(b, sizeof b, f, a, b2);
    return b;
}

// Nullable number: absent or null -> nullopt (no error), else read_number rules.
void read_optional(const json& obj, const char* key, const std::string& path, std::initializer_list<Limit> limits,
                   std::optional<double>& out, std::vector<ErrorDetail>& errs) {
    auto it = obj.find(key);
    if (it == obj.end() || it->is_null()) return;
    double v = 0;
    const size_t n = errs.size();
    read_number(obj, key, path, limits, v, errs);
    if (errs.size() == n) out = v;
}

const json* object_at(const json& body, const char* key, std::vector<ErrorDetail>& errs, bool required) {
    auto it = body.find(key);
    if (it == body.end()) {
        if (required) errs.push_back({key, "Field required"});
        return nullptr;
    }
    if (!it->is_object()) {
        errs.push_back({key, NOT_OBJECT});
        return nullptr;
    }
    return &*it;
}

std::string remap_scenario_field(const std::string& f) {
    if (f == "start_utc") return "landing_utc";
    if (f == "duration_hours") return "surface_hours";
    return f;
}

const char* pointing_name(PanelPointing p) {
    switch (p) {
        case PanelPointing::SunTracking: return "sun_tracking";
        case PanelPointing::Vertical: return "vertical";
        case PanelPointing::Horizontal: return "horizontal";
    }
    return "sun_tracking";
}

json nullable(const std::optional<double>& v) { return v ? json(*v) : json(nullptr); }

std::vector<Interval> spans_from(const json& windows, int64_t t0_us) {
    std::vector<Interval> out;
    if (!windows.is_array()) return out;
    for (const json& w : windows) {
        const double s = static_cast<double>(parse_utc(w["start_utc"].get<std::string>()) - t0_us) / 1e6;
        const double e = static_cast<double>(parse_utc(w["end_utc"].get<std::string>()) - t0_us) / 1e6;
        if (e > s) out.push_back({s, e, w.value("clipped_start", false), w.value("clipped_end", false)});
    }
    std::sort(out.begin(), out.end(), [](const Interval& a, const Interval& b) { return a.start < b.start; });
    return out;
}

json windows_json(const std::vector<Interval>& spans, int64_t t0_us, double total_s) {
    json out = json::array();
    for (const Interval& iv : spans)
        out.push_back({{"start_utc", format_utc(t0_us + static_cast<int64_t>(std::llround(iv.start * 1e6)))},
                       {"end_utc", format_utc(t0_us + static_cast<int64_t>(std::llround(iv.end * 1e6)))},
                       {"clipped_start", iv.start <= 0.0},
                       {"clipped_end", iv.end >= total_s}});
    return out;
}

// One simulation (no corrections).
struct Sim {
    bool not_ready = false;
    std::string message;
    json model, provenance = json::array(), assumptions = json::array(), warnings = json::array();
    bool synthetic = false;
    int64_t landing_us = 0;
    double delay_h = 0, surface_h = 0;
    double e0_wh = 0;
    std::optional<double> pre_energy_wh;
    json timeline = json::array(), windows;
    json inventory;  // null when not_ready or no surface time
    json constraints = json::array();
    std::string verdict = "incomplete";
    std::vector<std::string> failed;  // constraint ids
    std::optional<double> required_battery_wh, required_panel_area_m2;
    std::optional<int64_t> first_energy_violation_us, first_outage_violation_us;
};

struct Overrides {
    std::optional<double> battery_wh, panel_area_m2, surface_hours;
};

json constraint(const char* id, const std::string& label, const char* status, std::optional<double> value,
                std::optional<double> limit, std::optional<int64_t> first_us, const std::string& note) {
    return {{"id", id},
            {"label", label},
            {"status", status},
            {"value", nullable(value)},
            {"limit", nullable(limit)},
            {"first_violation_utc", first_us ? json(format_utc(*first_us)) : json(nullptr)},
            {"note", note}};
}

bool energy_ok(const EnergyResult& r) { return !r.first_below_reserve && r.unserved_wh <= 0; }

std::optional<double> bisect_min(const std::function<bool(double)>& ok, double hi, double quantum) {
    if (!ok(hi)) return std::nullopt;
    double lo = 0;
    if (ok(lo)) return 0.0;
    for (int i = 0; i < 60 && hi - lo > quantum / 4; ++i) {
        const double mid = 0.5 * (lo + hi);
        (ok(mid) ? hi : lo) = mid;
    }
    return std::ceil(hi / quantum) * quantum;
}

Sim simulate_once(const MissionRequest& req, const MissionContext& ctx, double delay_h, const Overrides& ov,
                  const json* slope_result) {
    Sim s;
    const bool has_power = req.power.has_value();
    PowerParams power = req.power.value_or(PowerParams{});
    if (ov.battery_wh) power.battery_capacity_wh = *ov.battery_wh;
    if (ov.panel_area_m2) power.panel_area_m2 = *ov.panel_area_m2;
    s.delay_h = delay_h;
    const int64_t planned_us = parse_utc(req.landing_utc);
    s.landing_us = planned_us + static_cast<int64_t>(std::llround(delay_h * 3600e6));
    s.surface_h = ov.surface_hours ? *ov.surface_hours
                  : req.end_policy == "fixed_end" ? req.surface_hours - delay_h
                                                  : req.surface_hours;
    if (has_power) {
        s.e0_wh = battery_at_landing_wh(power, delay_h, req.pre_landing_net_load_w);
        if (req.pre_landing_net_load_w) s.pre_energy_wh = *req.pre_landing_net_load_w * delay_h;
    }
    s.model = ctx.provider->model_info();
    s.model["horizon_model"] = req.terrain_mode == "dem" ? "dem_terrain" : "ideal_geometric";
    s.synthetic = ctx.provider->synthetic();
    s.windows = {{"sun_visible", json::array()}, {"earth_visible", json::array()},
                 {"link_available", req.radio ? json::array() : json(nullptr)}};

    // Surface time left after a delay under a fixed end.
    const bool fixed_end = req.end_policy == "fixed_end" && !ov.surface_hours;
    if (s.surface_h <= 0) {
        s.message = "No surface time left: the delay consumes the whole stay before the fixed end.";
        s.constraints.push_back(constraint("surface_time", "Surface time left after the delay", "fail", s.surface_h,
                                           0.0, s.landing_us, "end_policy fixed_end: stay = surface_hours - delay."));
        s.failed.push_back("surface_time");
        s.verdict = "no_go";
        s.inventory = nullptr;
        return s;
    }

    ScenarioRequest sc{req.site, format_utc(s.landing_us), s.surface_h, req.step_minutes, req.terrain_mode};
    json ev = evaluate(sc, *ctx.provider, ctx.terrain);
    s.model = ev["model"];
    s.model["horizon_model"] = ev["model"].value("horizon_model", req.terrain_mode == "dem" ? "dem_terrain" : "ideal_geometric");
    for (const auto& a : ev["assumptions"]) s.assumptions.push_back(a);
    for (const auto& w : ev["warnings"]) s.warnings.push_back(w);
    s.provenance = ev["data_provenance"];
    s.synthetic = ev["synthetic"].get<bool>();
    if (ev["status"] == "not_ready") {
        s.not_ready = true;
        s.message = ev["message"].get<std::string>();
        s.inventory = nullptr;
        return s;
    }

    const std::vector<int64_t> times = sample_times(sc);
    const size_t n = times.size();
    const double total_s = static_cast<double>(times.back() - times.front()) / 1e6;
    std::vector<double> t_s(n), sun_el(n);
    std::vector<bool> sun_vis(n), earth_vis(n);
    const json& samples = ev["samples"];
    for (size_t i = 0; i < n; ++i) {
        t_s[i] = static_cast<double>(times[i] - times[0]) / 1e6;
        const json& su = samples[i]["sun"];
        const json& ea = samples[i]["earth"];
        sun_el[i] = su["elevation_deg"].get<double>();
        sun_vis[i] = sun_el[i] > su.value("horizon_elevation_deg", 0.0);
        earth_vis[i] = ea["elevation_deg"].get<double>() > ea.value("horizon_elevation_deg", 0.0);
    }
    const std::vector<Interval> sun_spans = spans_from(ev["windows"]["sun_visible"], times[0]);
    const std::vector<Interval> earth_spans = spans_from(ev["windows"]["earth_visible"], times[0]);

    // Radio link (analytic ephemeris, ideal horizon + antenna mask), intersected with the DEM Earth visibility.
    std::optional<std::vector<Interval>> link_spans;
    std::optional<double> data_rate;
    if (req.radio) {
        RadioLinkRequest rr = *req.radio;
        rr.scenario = sc;
        rr.scenario.terrain_mode = "ideal";
        json rj = evaluate_radio_link(rr);
        auto spans = spans_from(rj["windows"]["link_available"], times[0]);
        if (req.terrain_mode == "dem") spans = intersect(spans, earth_spans);
        link_spans = spans;
        data_rate = rr.link.data_rate_bps;
        s.model["radio_model"] = rj["model"].value("ephemeris_provider", "analytic");
        for (const auto& p : rj["data_provenance"]) s.provenance.push_back(p);
        for (const auto& w : rj["warnings"]) s.warnings.push_back(w);
        s.assumptions.push_back(
            "Radio link: windows from the radio-link model (analytic low-precision ephemeris, ideal horizon plus the "
            "antenna mask, caller's link budget and stations)" +
            std::string(req.terrain_mode == "dem" ? ", intersected with the Earth visibility above the DEM terrain "
                                                    "horizon." : ".") +
            " A closing budget is a necessary condition, not a link guarantee.");
    } else {
        s.model["radio_model"] = nullptr;
        s.assumptions.push_back("No radio given: contact time is geometric Earth visibility only (not a radio link); "
                                "no data volume is computed.");
    }

    // Energy (optional: only when a power system is given).
    const double reserve_soc = req.constraints.min_battery_soc.value_or(0.0);
    const double cap = power.battery_capacity_wh;
    const EnergyResult er = has_power ? simulate_energy(t_s, sun_el, sun_vis, power, s.e0_wh, reserve_soc * cap)
                                      : EnergyResult{};
    if (!has_power)
        s.assumptions.push_back("Energy not modelled (no power system given): no battery or array figures, no "
                                "energy constraint. Sun visibility is still reported.");
    if (has_power) s.assumptions.push_back(fmt("Energy: P_solar = S0 x area x efficiency x cos(incidence) while the Sun's centre is "
                                "above the horizon, S0 = %.0f W/m2 (TSI at 1 AU); the +-3.4 %% heliocentric-distance "
                                "variation, partial solar disk, dust, temperature and degradation beyond the given "
                                "efficiency are not modelled.",
                                SOLAR_CONSTANT_W_M2));
    if (has_power) s.assumptions.push_back(std::string("Panel pointing '") + pointing_name(power.pointing) +
                            "'; constant load; battery charge/discharge efficiencies applied per step "
                            "(trapezoid on the sampled power). Screening estimate, not a power-system design.");
    if (s.delay_h > 0 && has_power)
        s.assumptions.push_back(req.pre_landing_net_load_w
                                    ? fmt("Delay before landing: battery drawn at %.1f W net for the whole delay.",
                                          *req.pre_landing_net_load_w)
                                    : "Delay before landing: energy used while waiting is NOT modelled (no "
                                      "pre_landing_net_load_w); the battery reaches the surface with its initial charge.");

    // Sizing (same delay, same load).
    auto run_ok = [&](PowerParams p) {
        const double e0 = battery_at_landing_wh(p, delay_h, req.pre_landing_net_load_w);
        return energy_ok(simulate_energy(t_s, sun_el, sun_vis, p, e0, reserve_soc * p.battery_capacity_wh));
    };
    if (has_power) s.required_battery_wh = bisect_min(
        [&](double c) {
            if (c <= 0) return false;
            PowerParams p = power;
            p.battery_capacity_wh = c;
            return run_ok(p);
        },
        1e7, 1.0);
    if (has_power) s.required_panel_area_m2 = bisect_min(
        [&](double a) {
            PowerParams p = power;
            p.panel_area_m2 = a;
            return run_ok(p);
        },
        1000.0, 0.01);

    // Timeline.
    for (size_t i = 0; i < n; ++i) {
        const double soc = has_power && cap > 0 ? er.battery_wh[i] / cap : 0.0;
        s.timeline.push_back({{"utc", format_utc(times[i])},
                              {"sun_visible", static_cast<bool>(sun_vis[i])},
                              {"earth_visible", static_cast<bool>(earth_vis[i])},
                              {"link_available", link_spans ? json(covered(*link_spans, t_s[i])) : json(nullptr)},
                              {"solar_w", has_power ? json(er.solar_w[i]) : json(nullptr)},
                              {"battery_wh", has_power ? json(er.battery_wh[i]) : json(nullptr)},
                              {"soc", has_power ? json(std::clamp(soc, 0.0, 1.0)) : json(nullptr)}});
    }
    s.windows = {{"sun_visible", ev["windows"]["sun_visible"]},
                 {"earth_visible", ev["windows"]["earth_visible"]},
                 {"link_available", link_spans ? windows_json(*link_spans, times[0], total_s) : json(nullptr)}};

    // Comms.
    const auto& contact = link_spans ? *link_spans : earth_spans;
    const double earth_h = total_seconds(earth_spans) / 3600, earth_gap_h = longest_gap_seconds(earth_spans, total_s) / 3600;
    std::optional<double> link_h, link_gap_h, volume;
    if (link_spans) {
        link_h = total_seconds(*link_spans) / 3600;
        link_gap_h = longest_gap_seconds(*link_spans, total_s) / 3600;
        volume = *link_h * 3600 * *data_rate / 1e6;
    }
    const double contact_h = link_h.value_or(earth_h), contact_gap_h = link_gap_h.value_or(earth_gap_h);
    const char* basis = link_spans ? "radio link" : "geometric Earth visibility";

    // Slope (time-independent, computed once by the caller).
    json slope = nullptr;
    if (slope_result) {
        const json& st = (*slope_result)["stats"];
        slope = {{"status", (*slope_result)["status"]},
                 {"verdict", (*slope_result)["verdict"]},
                 {"radius_m", LANDING_DISC_RADIUS_M},
                 {"max_slope_deg", *req.constraints.max_slope_deg},
                 {"fraction_ok", st.is_object() ? st["fraction_ok"] : json(nullptr)},
                 {"slope_max_deg", st.is_object() ? st["slope_max_deg"] : json(nullptr)},
                 {"slope_mean_deg", st.is_object() ? st["slope_mean_deg"] : json(nullptr)}};
    }

    const double min_soc = has_power && cap > 0 ? er.min_wh / cap : 0.0;
    auto pw = [&](double v) { return has_power ? json(v) : json(nullptr); };
    s.inventory = {
        {"landing_utc", format_utc(s.landing_us)},
        {"end_utc", format_utc(times.back())},
        {"surface_hours", total_s / 3600},
        {"energy",
         {{"generated_wh", pw(er.generated_wh)},
          {"load_wh", pw(er.load_wh)},
          {"unserved_wh", pw(er.unserved_wh)},
          {"curtailed_wh", pw(er.curtailed_wh)},
          {"soc_at_landing", pw(cap > 0 ? s.e0_wh / cap : 0.0)},
          {"final_soc", has_power && cap > 0 ? json(er.battery_wh.back() / cap) : pw(0.0)},
          {"min_soc", pw(min_soc)},
          {"min_soc_utc", has_power ? json(format_utc(times[er.min_index])) : json(nullptr)},
          {"hours_below_reserve", has_power && req.constraints.min_battery_soc ? json(er.hours_below_reserve) : json(nullptr)},
          {"sun_hours", total_seconds(sun_spans) / 3600},
          {"longest_sun_outage_hours", longest_gap_seconds(sun_spans, total_s) / 3600}}},
        {"sizing", has_power ? json{{"reserve_soc", reserve_soc},
                                    {"required_battery_wh", nullable(s.required_battery_wh)},
                                    {"required_panel_area_m2", nullable(s.required_panel_area_m2)}}
                             : json(nullptr)},
        {"comms",
         {{"contact_basis", link_spans ? "radio_link" : "geometric_earth_visibility"},
          {"earth_visible_hours", earth_h},
          {"longest_earth_outage_hours", earth_gap_h},
          {"link_hours", nullable(link_h)},
          {"longest_link_outage_hours", nullable(link_gap_h)},
          {"data_volume_mbit", nullable(volume)}}},
        {"slope", slope}};

    // Constraints.
    auto fail = [&](const char* id) { s.failed.push_back(id); };
    if (fixed_end)
        s.constraints.push_back(constraint("surface_time", "Surface time left after the delay", "pass", s.surface_h,
                                           0.0, std::nullopt, "end_policy fixed_end: stay = surface_hours - delay."));
    if (!has_power) {
        if (req.constraints.min_battery_soc)
            s.constraints.push_back(constraint("battery_reserve", fmt("Battery state of charge >= %.0f %%", reserve_soc * 100),
                                               "not_evaluated", std::nullopt, reserve_soc, std::nullopt,
                                               "Energy not modelled (power is null)."));
    } else {
        const bool ok = energy_ok(er);
        std::optional<int64_t> first;
        if (er.first_below_reserve) first = times[*er.first_below_reserve];
        else if (er.unserved_wh > 0) first = times[er.min_index];
        s.first_energy_violation_us = first;
        const std::string label = req.constraints.min_battery_soc
                                      ? fmt("Battery state of charge >= %.0f %%", reserve_soc * 100)
                                      : std::string("Battery never empty (load always supplied)");
        std::string note = fmt("Minimum %.1f %%", min_soc * 100);
        if (er.unserved_wh > 0) note += fmt("; %.0f Wh of load not supplied", er.unserved_wh);
        s.constraints.push_back(constraint("battery_reserve", label, ok ? "pass" : "fail", min_soc, reserve_soc, first, note));
        if (!ok) fail("battery_reserve");
    }
    if (req.constraints.max_earth_outage_hours) {
        const double lim = *req.constraints.max_earth_outage_hours;
        const bool ok = contact_gap_h <= lim;
        std::optional<int64_t> first;
        if (!ok) {  // first gap longer than the limit: violation at gap start + limit
            double prev = 0;
            for (size_t k = 0; k <= contact.size(); ++k) {
                const double next = k < contact.size() ? contact[k].start : total_s;
                if ((next - prev) / 3600 > lim) {
                    first = times[0] + static_cast<int64_t>(std::llround((prev + lim * 3600) * 1e6));
                    break;
                }
                if (k < contact.size()) prev = contact[k].end;
            }
        }
        s.first_outage_violation_us = first;
        s.constraints.push_back(constraint("earth_outage", std::string("Longest contact gap (") + basis + ")",
                                           ok ? "pass" : "fail", contact_gap_h, lim, first, "hours"));
        if (!ok) fail("earth_outage");
    }
    if (req.constraints.min_contact_hours) {
        const double lim = *req.constraints.min_contact_hours;
        const bool ok = contact_h >= lim;
        s.constraints.push_back(constraint("contact_hours", std::string("Contact time (") + basis + ")",
                                           ok ? "pass" : "fail", contact_h, lim, std::nullopt, "hours over the stay"));
        if (!ok) fail("contact_hours");
    }
    if (req.constraints.min_data_volume_mbit) {
        const double lim = *req.constraints.min_data_volume_mbit;
        if (!volume) {
            s.constraints.push_back(constraint("data_volume", "Data volume to Earth", "not_evaluated", std::nullopt, lim,
                                               std::nullopt, "Needs a radio link (radio is null)."));
        } else {
            const bool ok = *volume >= lim;
            s.constraints.push_back(constraint("data_volume", "Data volume to Earth", ok ? "pass" : "fail", *volume, lim,
                                               std::nullopt, "Mbit = link hours x data rate"));
            if (!ok) fail("data_volume");
        }
    }
    if (slope_result) {
        const std::string v = (*slope_result)["verdict"].get<std::string>();
        const json& st = (*slope_result)["stats"];
        const std::optional<double> frac =
            st.is_object() && st["fraction_ok"].is_number() ? std::optional<double>(st["fraction_ok"].get<double>()) : std::nullopt;
        const double need = req.constraints.min_slope_ok_fraction.value_or(1.0);
        const std::string label = fmt2("Landing disc (4 km) share <= %.1f deg (need %.0f %%)",
                                       *req.constraints.max_slope_deg, need * 100);
        if (v == "pass" || v == "fail") {
            s.constraints.push_back(constraint("landing_slope", label, v == "pass" ? "pass" : "fail", frac, need,
                                               std::nullopt, "20 m LOLA slope (Horn 3x3); not lander-footprint slope"));
            if (v == "fail") fail("landing_slope");
        } else {
            s.constraints.push_back(constraint("landing_slope", label, "not_evaluated", frac, need, std::nullopt,
                                               "Slope check " + (*slope_result)["status"].get<std::string>() + " / " + v));
        }
    }

    bool any_not_eval = false;
    for (const auto& c : s.constraints) any_not_eval |= c["status"] == "not_evaluated";
    s.verdict = !s.failed.empty() ? "no_go" : any_not_eval ? "incomplete" : "go";
    s.message = s.synthetic ? "SYNTHETIC: ephemerides or terrain are synthetic; these numbers do not describe a real mission."
                            : "Computed from the scenario evaluation, the caller's power system" +
                                  std::string(req.radio ? ", radio link" : "") + " and constraints.";
    return s;
}

SlopeCheckRequest landing_disc(double lat, double lon, double max_slope, std::optional<double> fraction) {
    SlopeCheckRequest sr;
    sr.center_latitude_deg = lat;
    sr.center_longitude_deg = lon;
    sr.radius_m = LANDING_DISC_RADIUS_M;
    sr.max_slope_deg = max_slope;
    sr.required_fraction = fraction.value_or(1.0);
    sr.max_nodata_fraction = 0.0;
    return sr;
}

// Point at great-circle distance d_km and bearing (deg from north toward east) from (lat, lon), on the
// 1737.4 km sphere; longitude wrapped to [-180, 180).
std::pair<double, double> destination(double lat, double lon, double bearing_deg, double d_km) {
    const double R = 1737.4, d = d_km / R, b = bearing_deg * DEG_RAD, p1 = lat * DEG_RAD;
    const double p2 = std::asin(std::sin(p1) * std::cos(d) + std::cos(p1) * std::sin(d) * std::cos(b));
    const double l2 = lon * DEG_RAD + std::atan2(std::sin(b) * std::sin(d) * std::cos(p1), std::cos(d) - std::sin(p1) * std::sin(p2));
    double lo = std::fmod(l2 / DEG_RAD + 180.0, 360.0);
    if (lo < 0) lo += 360.0;
    return {p2 / DEG_RAD, lo - 180.0};
}

}  // namespace

// --- pure pieces --------------------------------------------------------------------------------

double solar_power_w(const PowerParams& p, double el_deg, bool visible) {
    if (!visible) return 0.0;
    const double el = el_deg * DEG_RAD;
    double cos_i = 1.0;
    if (p.pointing == PanelPointing::Vertical) cos_i = std::cos(el);
    else if (p.pointing == PanelPointing::Horizontal) cos_i = std::sin(el);
    return SOLAR_CONSTANT_W_M2 * p.panel_area_m2 * p.panel_efficiency * std::max(0.0, cos_i);
}

EnergyResult simulate_energy(const std::vector<double>& t_s, const std::vector<double>& sun_el,
                             const std::vector<bool>& vis, const PowerParams& p, double e0, double reserve_wh) {
    EnergyResult r;
    const size_t n = t_s.size();
    r.solar_w.resize(n);
    r.battery_wh.resize(n);
    for (size_t i = 0; i < n; ++i) r.solar_w[i] = solar_power_w(p, sun_el[i], vis[i]);
    const double cap = p.battery_capacity_wh;
    double e = std::clamp(e0, 0.0, cap);
    r.battery_wh[0] = e;
    r.min_wh = e;
    if (e < reserve_wh) r.first_below_reserve = 0;
    for (size_t i = 1; i < n; ++i) {
        const double dt = (t_s[i] - t_s[i - 1]) / 3600.0;
        const double gen = 0.5 * (r.solar_w[i - 1] + r.solar_w[i]);
        r.generated_wh += gen * dt;
        r.load_wh += p.load_w * dt;
        const double net = gen - p.load_w;
        if (net >= 0) {
            e += net * p.charge_efficiency * dt;
            if (e > cap) {
                r.curtailed_wh += (e - cap) / p.charge_efficiency;
                e = cap;
            }
        } else {
            e -= -net * dt / p.discharge_efficiency;
            if (e < 0) {
                r.unserved_wh += -e * p.discharge_efficiency;
                e = 0;
            }
        }
        r.battery_wh[i] = e;
        if (e < r.min_wh) {
            r.min_wh = e;
            r.min_index = i;
        }
        if (e < reserve_wh) {
            r.hours_below_reserve += dt;
            if (!r.first_below_reserve) r.first_below_reserve = i;
        }
    }
    return r;
}

std::vector<Interval> intersect(const std::vector<Interval>& a, const std::vector<Interval>& b) {
    std::vector<Interval> out;
    size_t i = 0, j = 0;
    while (i < a.size() && j < b.size()) {
        const double s = std::max(a[i].start, b[j].start), e = std::min(a[i].end, b[j].end);
        if (e > s) out.push_back({s, e, false, false});
        (a[i].end < b[j].end ? i : j)++;
    }
    return out;
}

double total_seconds(const std::vector<Interval>& spans) {
    double t = 0;
    for (const auto& s : spans) t += s.end - s.start;
    return t;
}

double longest_gap_seconds(const std::vector<Interval>& spans, double total_s) {
    double prev = 0, best = 0;
    for (const auto& s : spans) {
        best = std::max(best, s.start - prev);
        prev = std::max(prev, s.end);
    }
    return std::max(best, total_s - prev);
}

bool covered(const std::vector<Interval>& spans, double t) {
    for (const auto& s : spans)
        if (t >= s.start && t <= s.end) return true;
    return false;
}

double battery_at_landing_wh(const PowerParams& p, double delay_hours, std::optional<double> net_load_w) {
    double e = p.battery_initial_soc * p.battery_capacity_wh;
    if (net_load_w) e -= *net_load_w * delay_hours / p.discharge_efficiency;
    return std::clamp(e, 0.0, p.battery_capacity_wh);
}

// --- parsing ------------------------------------------------------------------------------------

MissionRequest parse_mission_request(const json& body) {
    if (!body.is_object()) throw ValidationError(std::vector<ErrorDetail>{{"", NOT_OBJECT}});
    std::vector<ErrorDetail> errs;
    MissionRequest r;

    // Site, landing time, stay, step, terrain: scenario rules (messages), field names remapped.
    json sc = json::object();
    if (body.contains("site")) sc["site"] = body["site"];
    if (body.contains("landing_utc")) sc["start_utc"] = body["landing_utc"];
    if (body.contains("surface_hours")) sc["duration_hours"] = body["surface_hours"];
    for (const char* k : {"step_minutes", "terrain_mode"})
        if (body.contains(k)) sc[k] = body[k];
    try {
        const ScenarioRequest s = parse_request(sc);
        r.site = s.site;
        r.landing_utc = s.start_utc;
        r.surface_hours = s.duration_hours;
        r.step_minutes = s.step_minutes;
        r.terrain_mode = s.terrain_mode;
    } catch (const ValidationError& e) {
        for (auto d : e.details) {
            d.field = remap_scenario_field(d.field);
            errs.push_back(d);
        }
    }

    if (const json* d = object_at(body, "delay", errs, false)) {
        read_number(*d, "landing_delay_hours", "delay.landing_delay_hours", {{Limit::GE, 0}, {Limit::LE, 720}},
                    r.landing_delay_hours, errs);
        auto ep = d->find("end_policy");
        if (ep == d->end()) errs.push_back({"delay.end_policy", "Field required"});
        else if (!ep->is_string() || (*ep != "fixed_duration" && *ep != "fixed_end"))
            errs.push_back({"delay.end_policy", "Input should be 'fixed_duration' or 'fixed_end'"});
        else r.end_policy = ep->get<std::string>();
        read_optional(*d, "pre_landing_net_load_w", "delay.pre_landing_net_load_w", {{Limit::GE, 0}, {Limit::LE, 1e5}},
                      r.pre_landing_net_load_w, errs);
        reject_extra(*d, {"landing_delay_hours", "end_policy", "pre_landing_net_load_w"}, "delay.", errs);
    }

    auto power_it = body.find("power");
    const json* p = nullptr;
    if (power_it != body.end() && !power_it->is_null()) {
        if (power_it->is_object()) p = &*power_it;
        else errs.push_back({"power", NOT_OBJECT});
    }
    if (p) {
        r.power = PowerParams{};
        PowerParams& w = *r.power;
        read_number(*p, "panel_area_m2", "power.panel_area_m2", {{Limit::GE, 0}, {Limit::LE, 1000}}, w.panel_area_m2, errs);
        read_number(*p, "panel_efficiency", "power.panel_efficiency", {{Limit::GT, 0}, {Limit::LE, 1}}, w.panel_efficiency, errs);
        auto pt = p->find("panel_pointing");
        if (pt == p->end()) errs.push_back({"power.panel_pointing", "Field required"});
        else if (*pt == "sun_tracking") w.pointing = PanelPointing::SunTracking;
        else if (*pt == "vertical") w.pointing = PanelPointing::Vertical;
        else if (*pt == "horizontal") w.pointing = PanelPointing::Horizontal;
        else errs.push_back({"power.panel_pointing", "Input should be 'sun_tracking', 'vertical' or 'horizontal'"});
        read_number(*p, "load_w", "power.load_w", {{Limit::GE, 0}, {Limit::LE, 1e5}}, w.load_w, errs);
        read_number(*p, "battery_capacity_wh", "power.battery_capacity_wh", {{Limit::GT, 0}, {Limit::LE, 1e7}},
                    w.battery_capacity_wh, errs);
        read_number(*p, "battery_initial_soc", "power.battery_initial_soc", {{Limit::GE, 0}, {Limit::LE, 1}},
                    w.battery_initial_soc, errs);
        read_number(*p, "charge_efficiency", "power.charge_efficiency", {{Limit::GT, 0}, {Limit::LE, 1}}, w.charge_efficiency, errs);
        read_number(*p, "discharge_efficiency", "power.discharge_efficiency", {{Limit::GT, 0}, {Limit::LE, 1}},
                    w.discharge_efficiency, errs);
        reject_extra(*p,
                     {"panel_area_m2", "panel_efficiency", "panel_pointing", "load_w", "battery_capacity_wh",
                      "battery_initial_soc", "charge_efficiency", "discharge_efficiency"},
                     "power.", errs);
    }

    auto radio = body.find("radio");
    if (radio != body.end() && !radio->is_null()) {
        if (!radio->is_object()) {
            errs.push_back({"radio", NOT_OBJECT});
        } else {
            json rb = *radio;  // radio-link rules on a request built around the mission grid
            for (const char* k : {"site", "step_minutes"})
                if (body.contains(k)) rb[k] = body[k];
            rb["start_utc"] = body.value("landing_utc", json("2000-01-01T00:00:00Z"));
            rb["duration_hours"] = body.value("surface_hours", json(1));
            try {
                r.radio = parse_radio_link_request(rb);
            } catch (const ValidationError& e) {
                for (auto d : e.details) {
                    if (d.field.rfind("site", 0) == 0 || d.field == "start_utc" || d.field == "duration_hours" ||
                        d.field == "step_minutes")
                        continue;  // already reported against the mission fields
                    d.field = "radio." + d.field;
                    errs.push_back(d);
                }
            }
        }
    }

    if (const json* c = object_at(body, "constraints", errs, true)) {
        MissionConstraints& k = r.constraints;
        const char* keys[] = {"min_battery_soc", "max_earth_outage_hours", "min_contact_hours", "min_data_volume_mbit",
                              "max_slope_deg", "min_slope_ok_fraction"};
        for (const char* key : keys)
            if (!c->contains(key)) errs.push_back({std::string("constraints.") + key, "Field required"});
        read_optional(*c, "min_battery_soc", "constraints.min_battery_soc", {{Limit::GE, 0}, {Limit::LE, 1}}, k.min_battery_soc, errs);
        read_optional(*c, "max_earth_outage_hours", "constraints.max_earth_outage_hours", {{Limit::GE, 0}, {Limit::LE, 2160}},
                      k.max_earth_outage_hours, errs);
        read_optional(*c, "min_contact_hours", "constraints.min_contact_hours", {{Limit::GE, 0}, {Limit::LE, 2160}},
                      k.min_contact_hours, errs);
        read_optional(*c, "min_data_volume_mbit", "constraints.min_data_volume_mbit", {{Limit::GE, 0}}, k.min_data_volume_mbit, errs);
        read_optional(*c, "max_slope_deg", "constraints.max_slope_deg", {{Limit::GE, 0}, {Limit::LE, 90}}, k.max_slope_deg, errs);
        read_optional(*c, "min_slope_ok_fraction", "constraints.min_slope_ok_fraction", {{Limit::GE, 0}, {Limit::LE, 1}},
                      k.min_slope_ok_fraction, errs);
        reject_extra(*c,
                     {"min_battery_soc", "max_earth_outage_hours", "min_contact_hours", "min_data_volume_mbit",
                      "max_slope_deg", "min_slope_ok_fraction"},
                     "constraints.", errs);
    }

    if (const json* s = object_at(body, "search", errs, false)) {
        if (s->contains("max_extra_delay_hours"))
            read_number(*s, "max_extra_delay_hours", "search.max_extra_delay_hours", {{Limit::GE, 0}, {Limit::LE, 720}},
                        r.search_max_extra_delay_hours, errs);
        if (s->contains("step_hours"))
            read_number(*s, "step_hours", "search.step_hours", {{Limit::GE, 0.5}, {Limit::LE, 240}}, r.search_step_hours, errs);
        reject_extra(*s, {"max_extra_delay_hours", "step_hours"}, "search.", errs);
        if (r.search_step_hours > 0 && r.search_max_extra_delay_hours / r.search_step_hours > MAX_SEARCH_POINTS)
            errs.push_back({"search", "at most " + std::to_string(MAX_SEARCH_POINTS) +
                                          " search points (max_extra_delay_hours / step_hours)"});
    } else if (r.search_max_extra_delay_hours / r.search_step_hours > MAX_SEARCH_POINTS) {
        errs.push_back({"search", "default search exceeds the point limit"});
    }

    reject_extra(body,
                 {"site", "landing_utc", "surface_hours", "step_minutes", "terrain_mode", "delay", "power", "radio",
                  "constraints", "search"},
                 "", errs);
    if (!errs.empty()) throw ValidationError(errs);
    return r;
}

json to_json(const MissionRequest& r) {
    json out = {
        {"site", {{"latitude_deg", r.site.latitude_deg}, {"longitude_deg", r.site.longitude_deg}, {"observer_height_m", r.site.observer_height_m}}},
        {"landing_utc", r.landing_utc},
        {"surface_hours", r.surface_hours},
        {"step_minutes", r.step_minutes},
        {"terrain_mode", r.terrain_mode},
        {"delay", {{"landing_delay_hours", r.landing_delay_hours}, {"end_policy", r.end_policy},
                   {"pre_landing_net_load_w", nullable(r.pre_landing_net_load_w)}}},
    };
    if (r.power) {
        const PowerParams& p = *r.power;
        out["power"] = {{"panel_area_m2", p.panel_area_m2}, {"panel_efficiency", p.panel_efficiency},
                        {"panel_pointing", pointing_name(p.pointing)}, {"load_w", p.load_w},
                        {"battery_capacity_wh", p.battery_capacity_wh}, {"battery_initial_soc", p.battery_initial_soc},
                        {"charge_efficiency", p.charge_efficiency}, {"discharge_efficiency", p.discharge_efficiency}};
    } else {
        out["power"] = nullptr;
    }
    if (r.radio) {
        const LinkParams& l = r.radio->link;
        json st = json::array();
        for (const auto& s : r.radio->stations)
            st.push_back({{"name", s.name}, {"latitude_deg", s.latitude_deg}, {"longitude_deg", s.longitude_deg},
                          {"altitude_m", s.altitude_m}, {"min_elevation_deg", s.min_elevation_deg}});
        out["radio"] = {{"min_earth_elevation_deg", r.radio->min_earth_elevation_deg},
                        {"link", {{"frequency_hz", l.frequency_hz}, {"eirp_dbw", l.eirp_dbw},
                                  {"rx_g_over_t_db_k", l.rx_g_over_t_db_k}, {"other_losses_db", l.other_losses_db},
                                  {"data_rate_bps", l.data_rate_bps}, {"required_ebn0_db", l.required_ebn0_db}}},
                        {"stations", st}};
    } else {
        out["radio"] = nullptr;
    }
    const MissionConstraints& c = r.constraints;
    out["constraints"] = {{"min_battery_soc", nullable(c.min_battery_soc)},
                          {"max_earth_outage_hours", nullable(c.max_earth_outage_hours)},
                          {"min_contact_hours", nullable(c.min_contact_hours)},
                          {"min_data_volume_mbit", nullable(c.min_data_volume_mbit)},
                          {"max_slope_deg", nullable(c.max_slope_deg)},
                          {"min_slope_ok_fraction", nullable(c.min_slope_ok_fraction)}};
    out["search"] = {{"max_extra_delay_hours", r.search_max_extra_delay_hours}, {"step_hours", r.search_step_hours}};
    return out;
}

// --- full simulation ----------------------------------------------------------------------------

json simulate_mission(const MissionRequest& req, const MissionContext& ctx) {
    // Landing-zone slope: once (time-independent).
    std::optional<json> slope;
    if (req.constraints.max_slope_deg) {
        SlopeCheckRequest sr;
        sr.center_latitude_deg = req.site.latitude_deg;
        sr.center_longitude_deg = req.site.longitude_deg;
        sr.radius_m = LANDING_DISC_RADIUS_M;
        sr.max_slope_deg = *req.constraints.max_slope_deg;
        sr.required_fraction = req.constraints.min_slope_ok_fraction.value_or(1.0);
        sr.max_nodata_fraction = 0.0;
        slope = slope_check(sr, ctx.slope_dem, ctx.slope_unavailable_reason);
    }
    const json* slope_ptr = slope ? &*slope : nullptr;

    const Sim s = simulate_once(req, ctx, req.landing_delay_hours, {}, slope_ptr);
    const int64_t planned_us = parse_utc(req.landing_utc);

    json corrections = json::array();
    json date_scan = nullptr;
    if (s.verdict == "no_go") {
        auto has = [&](const char* id) { return std::find(s.failed.begin(), s.failed.end(), id) != s.failed.end(); };
        std::string why;
        for (const auto& f : s.failed) why += (why.empty() ? "" : ", ") + f;
        corrections.push_back({{"kind", "abort"}, {"feasible", true},
                               {"summary", "Abort before landing (failed: " + why + ")."},
                               {"landing_utc", nullptr}, {"surface_hours", nullptr}, {"battery_capacity_wh", nullptr},
                               {"panel_area_m2", nullptr}, {"site", nullptr}, {"max_slope_deg", nullptr},
                               {"verdict", nullptr}});
        auto correction = [&](const char* kind, bool feasible, const std::string& summary, std::optional<int64_t> landing,
                              std::optional<double> hours, std::optional<double> battery, std::optional<double> area,
                              std::optional<std::string> verdict, std::optional<std::pair<double, double>> site = std::nullopt,
                              std::optional<double> max_slope = std::nullopt) {
            corrections.push_back({{"kind", kind}, {"feasible", feasible}, {"summary", summary},
                                   {"landing_utc", landing ? json(format_utc(*landing)) : json(nullptr)},
                                   {"surface_hours", nullable(hours)}, {"battery_capacity_wh", nullable(battery)},
                                   {"panel_area_m2", nullable(area)},
                                   {"site", site ? json{{"latitude_deg", site->first}, {"longitude_deg", site->second}}
                                                 : json(nullptr)},
                                   {"max_slope_deg", nullable(max_slope)},
                                   {"verdict", verdict ? json(*verdict) : json(nullptr)}});
        };
        // The slope does not depend on time: when it fails, the time searches (retime, date scan) ignore it
        // and report the dates that fix everything ELSE; the site/slope suggestions below handle the slope.
        const bool slope_fails = has("landing_slope");
        const json* time_slope = slope_fails ? nullptr : slope_ptr;
        const std::string slope_note =
            slope_fails ? " except the landing slope, which fails at this site on any date (fixes the date part only — see Move the site)"
                        : "";
        auto time_only_failures = [&] {
            for (const auto& f : s.failed)
                if (f != "landing_slope") return true;
            return false;
        }();

        // Retime landing (cannot fix the slope: the site does not change).
        if (!time_only_failures) {
            correction("retime_landing", false, "Only the landing-zone slope fails: moving the landing time cannot fix it.",
                       std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt);
        } else if (has("surface_time")) {
            correction("retime_landing", false,
                       "Fixed end: no surface time is left, and a later landing would only shorten the stay further.",
                       std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt);
        } else if (!s.not_ready) {
            const int steps = static_cast<int>(std::floor(req.search_max_extra_delay_hours / req.search_step_hours + 1e-9));
            bool found = false;
            for (int k = 1; k <= steps && !found; ++k) {
                const double d = req.landing_delay_hours + k * req.search_step_hours;
                const Sim t = simulate_once(req, ctx, d, {}, time_slope);
                if (t.verdict == "go") {
                    found = true;
                    correction("retime_landing", true,
                               fmt("Land %.1f h later than the delayed landing (", k * req.search_step_hours) +
                                   format_utc(t.landing_us) + "): every constraint passes" + slope_note + ".",
                               t.landing_us, t.surface_h, std::nullopt, std::nullopt,
                               slope_fails ? std::string("no_go") : t.verdict);
                }
            }
            if (!found)
                correction("retime_landing", false,
                           fmt("No landing time passing every constraint within +%.0f h", req.search_max_extra_delay_hours) +
                               fmt(" (step %.1f h).", req.search_step_hours),
                           std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt);
        }

        // Change the planned date: re-simulate the same mission (no delay) at nearby landing dates, earlier
        // and later, and propose the nearest one that passes.
        if (!time_only_failures) {
            correction("change_date", false, "Only the landing-zone slope fails: the date is fine, the site is not (see Move the site).",
                       std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt);
        } else if (!s.not_ready) {
            const double step = req.search_step_hours;
            const int steps = static_cast<int>(std::floor(req.search_max_extra_delay_hours / step + 1e-9));
            json points = json::array();
            std::optional<std::pair<int, Sim>> best;
            for (int k = -steps; k <= steps; ++k) {
                MissionRequest rq = req;
                rq.landing_utc = format_utc(planned_us + static_cast<int64_t>(std::llround(k * step * 3600e6)));
                rq.landing_delay_hours = 0;
                rq.end_policy = "fixed_duration";
                Sim t = simulate_once(rq, ctx, 0.0, {}, time_slope);
                json failed = json::array();
                for (const auto& f : t.failed) failed.push_back(f);
                points.push_back({{"landing_utc", format_utc(t.landing_us)},
                                  {"offset_hours", k * step},
                                  {"verdict", t.not_ready ? std::string("incomplete") : t.verdict},
                                  {"failed", failed}});
                // nearest passing date; on a tie the later one (a launch slip is likelier than an advance)
                if (t.verdict == "go" && (!best || std::abs(k) < std::abs(best->first) ||
                                          (std::abs(k) == std::abs(best->first) && k > best->first)))
                    best.emplace(k, std::move(t));
            }
            date_scan = {{"step_hours", step}, {"range_hours", steps * step},
                         {"ignored_constraints", slope_fails ? json::array({"landing_slope"}) : json::array()},
                         {"points", points}};
            if (best) {
                const double off = best->first * step;
                correction("change_date", true,
                           "Plan the landing on " + format_utc(best->second.landing_us).substr(0, 16) + " UTC (" +
                               fmt("%+.1f days", off / 24) + fmt(" from the planned date, %.0f h stay): every constraint passes",
                                                                 best->second.surface_h) + slope_note + ".",
                           best->second.landing_us, best->second.surface_h, std::nullopt, std::nullopt,
                           std::string(slope_fails ? "no_go" : "go"));
            } else {
                correction("change_date", false,
                           fmt("No landing date within +-%.0f days passes every constraint", steps * step / 24) + slope_note +
                               fmt(" (step %.1f h).", step),
                           std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt);
            }
        }

        // Slope: move the site, or relax the threshold.
        // At a modified site/limit, the nearest date (planned first, then +-step, +-2 step, ...) that passes.
        auto nearest_go_date = [&](const MissionRequest& base, const json* slope) -> std::optional<Sim> {
            const double step = req.search_step_hours;
            const int steps = static_cast<int>(std::floor(req.search_max_extra_delay_hours / step + 1e-9));
            for (int a = 0; a <= steps; ++a)
                for (int sign : {1, -1}) {
                    if (a == 0 && sign < 0) continue;
                    MissionRequest rq = base;
                    rq.landing_utc = format_utc(planned_us + static_cast<int64_t>(std::llround(sign * a * step * 3600e6)));
                    rq.landing_delay_hours = 0;
                    rq.end_policy = "fixed_duration";
                    Sim t = simulate_once(rq, ctx, 0.0, {}, slope);
                    if (t.verdict == "go") return t;
                }
            return std::nullopt;
        };
        auto with_date = [&](const Sim& t) {
            const double off = static_cast<double>(t.landing_us - planned_us) / 3600e6;
            return " and land on " + format_utc(t.landing_us).substr(0, 16) + " UTC" +
                   (std::fabs(off) < 1e-6 ? std::string(" (the planned date)") : fmt(" (%+.1f days)", off / 24));
        };
        if (slope_fails && ctx.slope_dem) {
            const double max_slope = *req.constraints.max_slope_deg;
            const auto frac = req.constraints.min_slope_ok_fraction;
            // Nearest site within 10 km (0.5 km rings, 16 bearings) whose 4 km disc passes.
            std::optional<std::pair<double, double>> moved;
            double moved_km = 0;
            for (double r_km = 0.5; r_km <= 10.0 + 1e-9 && !moved; r_km += 0.5)
                for (int b = 0; b < 16 && !moved; ++b) {
                    const auto [la, lo] = destination(req.site.latitude_deg, req.site.longitude_deg, b * 22.5, r_km);
                    const json c = slope_check(landing_disc(la, lo, max_slope, frac), ctx.slope_dem, ctx.slope_unavailable_reason);
                    if (c["verdict"] == "pass") {
                        moved = std::make_pair(std::round(la * 1e5) / 1e5, std::round(lo * 1e5) / 1e5);
                        moved_km = r_km;
                    }
                }
            if (moved) {
                MissionRequest rq = req;
                rq.site.latitude_deg = moved->first;
                rq.site.longitude_deg = moved->second;
                const json moved_slope = slope_check(landing_disc(moved->first, moved->second, max_slope, frac), ctx.slope_dem,
                                                     ctx.slope_unavailable_reason);
                const Sim t = simulate_once(rq, ctx, req.landing_delay_hours, {}, &moved_slope);
                const std::string where = fmt2("Land %.1f km away, at %.4f", moved_km, moved->first) + fmt(", %.4f", moved->second);
                if (t.verdict == "go") {
                    correction("move_site", true, where + ": every constraint passes there.", t.landing_us, t.surface_h,
                               std::nullopt, std::nullopt, t.verdict, moved);
                } else if (auto dt = nearest_go_date(rq, &moved_slope)) {
                    correction("move_site", true, where + with_date(*dt) + ": every constraint passes.", dt->landing_us,
                               dt->surface_h, std::nullopt, std::nullopt, dt->verdict, moved);
                } else {
                    correction("move_site", false,
                               where + ": the slope passes there, but no date within the search range passes the rest.",
                               t.landing_us, t.surface_h, std::nullopt, std::nullopt, t.verdict, moved);
                }
            } else {
                correction("move_site", false, "No site within 10 km has a 4 km disc passing the slope limit.", std::nullopt,
                           std::nullopt, std::nullopt, std::nullopt, std::nullopt);
            }
            // Smallest slope limit that passes here (same required share).
            auto passes = [&](double lim) {
                return slope_check(landing_disc(req.site.latitude_deg, req.site.longitude_deg, lim, frac), ctx.slope_dem,
                                   ctx.slope_unavailable_reason)["verdict"] == "pass";
            };
            if (passes(90.0)) {
                double lo = max_slope, hi = 90.0;
                for (int i = 0; i < 30 && hi - lo > 0.02; ++i) ((passes(0.5 * (lo + hi))) ? hi : lo) = 0.5 * (lo + hi);
                const double lim = std::ceil(hi * 10.0) / 10.0;
                MissionRequest rq = req;
                rq.constraints.max_slope_deg = lim;
                const json relaxed = slope_check(landing_disc(req.site.latitude_deg, req.site.longitude_deg, lim, frac),
                                                 ctx.slope_dem, ctx.slope_unavailable_reason);
                const Sim t = simulate_once(rq, ctx, req.landing_delay_hours, {}, &relaxed);
                const std::string what = fmt2("Accept slopes up to %.1f deg (instead of %.1f deg) on ", lim, max_slope) +
                                         fmt("%.0f %% of the disc", frac.value_or(1.0) * 100);
                if (t.verdict == "go") {
                    correction("relax_slope", true, what + ": every constraint passes.", t.landing_us, t.surface_h,
                               std::nullopt, std::nullopt, t.verdict, std::nullopt, lim);
                } else if (auto dt = nearest_go_date(rq, &relaxed)) {
                    correction("relax_slope", true, what + with_date(*dt) + ": every constraint passes.", dt->landing_us,
                               dt->surface_h, std::nullopt, std::nullopt, dt->verdict, std::nullopt, lim);
                } else {
                    correction("relax_slope", false, what + ": the slope then passes, but no date within the search range passes the rest.",
                               t.landing_us, t.surface_h, std::nullopt, std::nullopt, t.verdict, std::nullopt, lim);
                }
            }
        }

        // Shorten the stay: only helps time-limited failures (battery, outage).
        bool shortenable = !s.failed.empty();
        for (const auto& f : s.failed) shortenable &= f == "battery_reserve" || f == "earth_outage";
        if (shortenable && !s.not_ready) {
            std::optional<int64_t> tv;
            for (auto v : {s.first_energy_violation_us, s.first_outage_violation_us})
                if (v && (!tv || *v < *tv)) tv = v;
            const double step_h = req.step_minutes / 60.0;
            const double hours = tv ? std::floor((static_cast<double>(*tv - s.landing_us) / 3600e6) / step_h) * step_h - step_h : 0;
            if (hours > 0) {
                Overrides o;
                o.surface_hours = hours;
                const Sim t = simulate_once(req, ctx, req.landing_delay_hours, o, slope_ptr);
                correction("shorten_stay", t.verdict == "go",
                           fmt("End the stay after %.1f h (before the first violation).", hours) +
                               (t.verdict == "go" ? "" : " Still failing: " + t.verdict + "."),
                           s.landing_us, hours, std::nullopt, std::nullopt, t.verdict);
            } else {
                correction("shorten_stay", false, "The first violation happens right after landing: no shorter stay helps.",
                           std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt);
            }
        }

        // Resize battery / panels (energy failures only).
        if (has("battery_reserve")) {
            if (s.required_battery_wh) {
                Overrides o;
                o.battery_wh = std::max(1.0, *s.required_battery_wh);
                const Sim t = simulate_once(req, ctx, req.landing_delay_hours, o, slope_ptr);
                correction("resize_battery", t.verdict == "go",
                           fmt("Battery of %.0f Wh", *o.battery_wh) + fmt(" instead of %.0f Wh (same initial SoC, panels, load).",
                                                                         req.power->battery_capacity_wh),
                           s.landing_us, s.surface_h, *o.battery_wh, std::nullopt, t.verdict);
            } else {
                correction("resize_battery", false, "No battery up to 1e7 Wh keeps the reserve.", std::nullopt, std::nullopt,
                           std::nullopt, std::nullopt, std::nullopt);
            }
            if (s.required_panel_area_m2) {
                Overrides o;
                o.panel_area_m2 = *s.required_panel_area_m2;
                const Sim t = simulate_once(req, ctx, req.landing_delay_hours, o, slope_ptr);
                correction("resize_panels", t.verdict == "go",
                           fmt2("Solar array of %.2f m2 instead of %.2f m2 (same battery and load).", *o.panel_area_m2,
                                req.power->panel_area_m2),
                           s.landing_us, s.surface_h, std::nullopt, *o.panel_area_m2, t.verdict);
            } else {
                const double reserve_wh = req.constraints.min_battery_soc.value_or(0.0) * req.power->battery_capacity_wh;
                correction("resize_panels", false,
                           s.e0_wh < reserve_wh || s.e0_wh <= 0
                               ? "No array helps: the battery is already below the reserve at landing (drained during "
                                 "the delay)."
                               : "No array up to 1000 m2 keeps the reserve: the battery cannot bridge the longest "
                                 "period without Sun.",
                           std::nullopt, std::nullopt, std::nullopt, std::nullopt, std::nullopt);
            }
        }
    }

    json assumptions = s.assumptions;
    assumptions.push_back("Corrections are re-simulated with the same models; 'go' means every applied constraint "
                          "passes under these screening models, not a mission certification.");
    if (req.constraints.max_slope_deg)
        assumptions.push_back("Landing slope: 20 m LOLA DEM slope (Horn 3x3) over a 4 km disc centred on the site; "
                              "not lander-footprint slope.");

    const double cap = req.power ? req.power->battery_capacity_wh : 0.0;
    return {
        {"schema_version", SCHEMA_VERSION},
        {"status", s.not_ready ? "not_ready" : s.synthetic ? "synthetic" : "computed"},
        {"synthetic", s.synthetic},
        {"message", s.message},
        {"request", to_json(req)},
        {"model", [&] {
             json m = s.model;
             m["energy_model"] = req.power ? json("solar array (constant S0) + battery, trapezoid time stepping")
                                           : json(nullptr);
             if (!m.contains("radio_model")) m["radio_model"] = nullptr;
             if (!m.contains("horizon_model")) m["horizon_model"] = req.terrain_mode == "dem" ? "dem_terrain" : "ideal_geometric";
             return m;
         }()},
        {"data_provenance", s.provenance},
        {"assumptions", assumptions},
        {"warnings", s.warnings},
        {"pre_landing",
         {{"planned_landing_utc", format_utc(planned_us)},
          {"landing_utc", format_utc(s.landing_us)},
          {"landing_delay_hours", req.landing_delay_hours},
          {"end_policy", req.end_policy},
          {"net_load_w", nullable(req.pre_landing_net_load_w)},
          {"energy_wh", nullable(s.pre_energy_wh)},
          {"soc_at_landing", req.power && cap > 0 ? json(s.e0_wh / cap) : json(nullptr)}}},
        {"timeline", s.timeline},
        {"windows", s.windows},
        {"inventory", s.inventory},
        {"constraints", s.constraints},
        {"verdict", s.not_ready ? std::string("incomplete") : s.verdict},
        {"corrections", corrections},
        {"date_scan", date_scan},
    };
}

}  // namespace selene
