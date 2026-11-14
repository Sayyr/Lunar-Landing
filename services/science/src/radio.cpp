#include "radio.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

#include "evaluate.hpp"
#include "geometry.hpp"
#include "intervals.hpp"
#include "lunar_ephemeris.hpp"

namespace selene {

using namespace validate;

namespace {

const char* const EPHEMERIS_PROVIDER = "analytic_meeus_truncated";
const double LOW_ELEVATION_WARNING_DEG = 5.0;
const int64_t FIXED_TT_OFFSET_VALID_FROM_US = 1483228800LL * 1000000LL;  // 2017-01-01T00:00:00Z

const std::vector<std::string> ASSUMPTIONS = {
    "ENGINEERING tier: a window means the modelled budget closes with the hardware figures of "
    "the request. It is a necessary condition, not a guaranteed radio link.",
    "Ephemeris: analytic truncated series (Meeus, Astronomical Algorithms, ch. 47 and 53), "
    "optical librations only. Earth direction from the site is good to ~0.1 deg; near the lunar "
    "poles that can shift a window edge by hours. Not cross-checked against SPICE yet.",
    "Lunar side: ideal geometric horizon (elevation 0 deg) on a 1737.4 km sphere; local terrain "
    "is ignored. Visibility is tested on the Earth's CENTRE against min_earth_elevation_deg; a "
    "ground station can be up to ~0.95 deg away from that direction.",
    "Earth side: a station is usable when the Moon's centre is above its min_elevation_deg "
    "(WGS84 geodetic horizon, no refraction, no local mask). Station availability, scheduling "
    "and weather are not modelled.",
    "Link budget: free-space path loss only (EIRP + G/T - FSPL - other_losses_db - 10log10(k_B) "
    "- 10log10(bit rate)). Pointing, polarisation, atmosphere and lunar-surface multipath must "
    "be included in other_losses_db by the caller; none is added here.",
    "Range is station to site (station to Moon centre minus the site's offset along the "
    "Earth-Moon line, transverse term <= 4 km). Doppler is one-way, first order in v/c, from a "
    "1 s central difference of that range.",
    "The serving station at each sample is the one with the largest elevation above its own "
    "mask. Link windows are the intersection of Earth-visible, any-station-visible and "
    "budget-closes intervals; each edge is linearly interpolated between samples, and events "
    "shorter than the sampling step may be missed.",
    "Time: UTC at the API boundary; TT = UTC + 69.184 s (fixed, no leap-second table); Earth "
    "rotation from Greenwich mean sidereal time with UT1 ~= UTC.",
};

int64_t round_us(double us) { return static_cast<int64_t>(std::nearbyint(us)); }

json windows_json(int64_t t0, const std::vector<Interval>& intervals) {
    json out = json::array();
    for (const Interval& iv : intervals)
        out.push_back({
            {"start_utc", format_utc(t0 + round_us(iv.start * 1e6))},
            {"end_utc", format_utc(t0 + round_us(iv.end * 1e6))},
            {"clipped_start", iv.clipped_start},
            {"clipped_end", iv.clipped_end},
        });
    return out;
}

double covered_seconds(const std::vector<Interval>& intervals) {
    double total = 0.0;
    for (const Interval& iv : intervals) total += iv.end - iv.start;
    return total;
}

// Sorted, disjoint union of interval lists (pieces that touch or overlap are merged).
std::vector<Interval> unite(std::vector<Interval> all, double span) {
    std::sort(all.begin(), all.end(), [](const Interval& a, const Interval& b) { return a.start < b.start; });
    std::vector<Interval> out;
    for (const Interval& iv : all) {
        if (!out.empty() && iv.start <= out.back().end)
            out.back().end = std::max(out.back().end, iv.end);
        else
            out.push_back(iv);
    }
    for (Interval& iv : out) iv.clipped_start = iv.start <= 0.0, iv.clipped_end = iv.end >= span;
    return out;
}

// Intersection of two sorted, disjoint interval lists.
std::vector<Interval> intersect(const std::vector<Interval>& a, const std::vector<Interval>& b, double span) {
    std::vector<Interval> out;
    for (size_t i = 0, j = 0; i < a.size() && j < b.size();) {
        const double start = std::max(a[i].start, b[j].start), end = std::min(a[i].end, b[j].end);
        if (start < end) out.push_back({start, end, start <= 0.0, end >= span});
        (a[i].end < b[j].end ? i : j)++;
    }
    return out;
}

// Longest stretch of [0, span] not covered by `intervals` (sorted, disjoint), seconds.
double longest_gap_seconds(const std::vector<Interval>& intervals, double span) {
    double longest = 0.0, cursor = 0.0;
    for (const Interval& iv : intervals) {
        longest = std::max(longest, iv.start - cursor);
        cursor = iv.end;
    }
    return std::max(longest, span - cursor);
}

json to_json(const RadioLinkRequest& r) {
    json stations = json::array();
    for (const GroundStation& s : r.stations)
        stations.push_back({{"name", s.name},
                            {"latitude_deg", s.latitude_deg},
                            {"longitude_deg", s.longitude_deg},
                            {"altitude_m", s.altitude_m},
                            {"min_elevation_deg", s.min_elevation_deg}});
    return {
        {"site",
         {{"latitude_deg", r.scenario.site.latitude_deg},
          {"longitude_deg", r.scenario.site.longitude_deg},
          {"observer_height_m", r.scenario.site.observer_height_m}}},
        {"start_utc", r.scenario.start_utc},
        {"duration_hours", r.scenario.duration_hours},
        {"step_minutes", r.scenario.step_minutes},
        {"min_earth_elevation_deg", r.min_earth_elevation_deg},
        {"link",
         {{"frequency_hz", r.link.frequency_hz},
          {"eirp_dbw", r.link.eirp_dbw},
          {"rx_g_over_t_db_k", r.link.rx_g_over_t_db_k},
          {"other_losses_db", r.link.other_losses_db},
          {"data_rate_bps", r.link.data_rate_bps},
          {"required_ebn0_db", r.link.required_ebn0_db}}},
        {"stations", stations},
    };
}

// Station-to-site range (km) for station `s` at `jd_utc`.
double site_range_km(const RadioLinkRequest& r, const GroundStation& s, double jd_utc) {
    const MoonGeometry m = moon_geometry(jd_utc + TT_MINUS_UTC_S / 86400.0);
    const StationView v = moon_from_earth_station(moon_earth_fixed_km(m, jd_utc), deg_to_rad(s.latitude_deg),
                                                  deg_to_rad(s.longitude_deg), s.altitude_m / 1000.0);
    return v.range_km - site_offset_toward_earth_km(m, deg_to_rad(r.scenario.site.latitude_deg),
                                                    deg_to_rad(r.scenario.site.longitude_deg),
                                                    r.scenario.site.observer_height_m / 1000.0);
}

}  // namespace

RadioLinkRequest parse_radio_link_request(const json& body) {
    if (!body.is_object()) throw ValidationError(std::vector<ErrorDetail>{{"", NOT_OBJECT}});
    std::vector<ErrorDetail> errs;
    RadioLinkRequest r{};

    // Site and time grid: same rules (and messages) as a scenario request.
    json scenario = json::object();
    for (const char* key : {"site", "start_utc", "duration_hours", "step_minutes"})
        if (body.contains(key)) scenario[key] = body[key];
    scenario["terrain_mode"] = "ideal";
    try {
        r.scenario = parse_request(scenario);
    } catch (const ValidationError& e) {
        errs = e.details;
    }

    read_number(body, "min_earth_elevation_deg", "min_earth_elevation_deg", {{Limit::GE, 0}, {Limit::LE, 90}},
                r.min_earth_elevation_deg, errs);

    auto link = body.find("link");
    if (link == body.end()) {
        errs.push_back({"link", "Field required"});
    } else if (!link->is_object()) {
        errs.push_back({"link", NOT_OBJECT});
    } else {
        read_number(*link, "frequency_hz", "link.frequency_hz", {{Limit::GE, 1e6}, {Limit::LE, 1e12}},
                    r.link.frequency_hz, errs);
        read_number(*link, "eirp_dbw", "link.eirp_dbw", {{Limit::GE, -100}, {Limit::LE, 200}}, r.link.eirp_dbw,
                    errs);
        read_number(*link, "rx_g_over_t_db_k", "link.rx_g_over_t_db_k", {{Limit::GE, -100}, {Limit::LE, 100}},
                    r.link.rx_g_over_t_db_k, errs);
        read_number(*link, "other_losses_db", "link.other_losses_db", {{Limit::GE, 0}, {Limit::LE, 100}},
                    r.link.other_losses_db, errs);
        read_number(*link, "data_rate_bps", "link.data_rate_bps", {{Limit::GE, 1}, {Limit::LE, 1e12}},
                    r.link.data_rate_bps, errs);
        read_number(*link, "required_ebn0_db", "link.required_ebn0_db", {{Limit::GE, -20}, {Limit::LE, 60}},
                    r.link.required_ebn0_db, errs);
        reject_extra(*link,
                     {"frequency_hz", "eirp_dbw", "rx_g_over_t_db_k", "other_losses_db", "data_rate_bps",
                      "required_ebn0_db"},
                     "link.", errs);
    }

    auto stations = body.find("stations");
    if (stations == body.end()) {
        errs.push_back({"stations", "Field required"});
    } else if (!stations->is_array()) {
        errs.push_back({"stations", "Input should be a valid list"});
    } else if (stations->empty() || stations->size() > static_cast<size_t>(MAX_STATIONS)) {
        errs.push_back({"stations", "List should have between 1 and " + std::to_string(MAX_STATIONS) + " items"});
    } else {
        for (size_t i = 0; i < stations->size(); ++i) {
            const json& item = (*stations)[i];
            const std::string prefix = "stations." + std::to_string(i);
            if (!item.is_object()) {
                errs.push_back({prefix, NOT_OBJECT});
                continue;
            }
            GroundStation s{};
            auto name = item.find("name");
            if (name == item.end()) {
                errs.push_back({prefix + ".name", "Field required"});
            } else if (!name->is_string()) {
                errs.push_back({prefix + ".name", "Input should be a valid string"});
            } else {
                s.name = name->get<std::string>();
                if (s.name.empty() || s.name.size() > 64)
                    errs.push_back({prefix + ".name", "String should have between 1 and 64 characters"});
                for (const GroundStation& other : r.stations)
                    if (other.name == s.name) errs.push_back({prefix + ".name", "Station names must be unique"});
            }
            read_number(item, "latitude_deg", prefix + ".latitude_deg", {{Limit::GE, -90}, {Limit::LE, 90}},
                        s.latitude_deg, errs);
            read_number(item, "longitude_deg", prefix + ".longitude_deg", {{Limit::GE, -180}, {Limit::LT, 180}},
                        s.longitude_deg, errs);
            read_number(item, "altitude_m", prefix + ".altitude_m", {{Limit::GE, -500}, {Limit::LE, 9000}},
                        s.altitude_m, errs);
            read_number(item, "min_elevation_deg", prefix + ".min_elevation_deg", {{Limit::GE, 0}, {Limit::LE, 90}},
                        s.min_elevation_deg, errs);
            reject_extra(item, {"name", "latitude_deg", "longitude_deg", "altitude_m", "min_elevation_deg"},
                         prefix + ".", errs);
            r.stations.push_back(std::move(s));
        }
    }

    reject_extra(body,
                 {"site", "start_utc", "duration_hours", "step_minutes", "min_earth_elevation_deg", "link",
                  "stations"},
                 "", errs);
    if (!errs.empty()) throw ValidationError(std::move(errs));
    return r;
}

json evaluate_radio_link(const RadioLinkRequest& r) {
    const std::vector<int64_t> times = sample_times(r.scenario);
    const int64_t t0 = times.front();
    const double span_s = static_cast<double>(times.back() - t0) / 1e6;
    const double lat = deg_to_rad(r.scenario.site.latitude_deg), lon = deg_to_rad(r.scenario.site.longitude_deg);
    const double height_km = r.scenario.site.observer_height_m / 1000.0;  // m -> km
    const size_t n_stations = r.stations.size();

    std::vector<double> seconds, earth_f, budget_f;
    std::vector<std::vector<double>> station_f(n_stations);
    json samples = json::array();
    double margin_min = std::numeric_limits<double>::infinity(), margin_max = -margin_min;
    double doppler_abs_max = 0.0, earth_el_min_in_link = std::numeric_limits<double>::infinity();

    for (int64_t t : times) {
        const double jd = julian_date_utc(t);
        const MoonGeometry m = moon_geometry(jd + TT_MINUS_UTC_S / 86400.0);

        // Lunar side: Earth's centre in the site's local frame.
        const auto [az_deg, el_deg] = azimuth_elevation_from_enu(earth_from_lunar_site_enu_km(m, lat, lon, height_km));
        const double earth_margin = el_deg - r.min_earth_elevation_deg;

        // Earth side: every station's view of the Moon; serve from the best one.
        const Vec3 moon_ef = moon_earth_fixed_km(m, jd);
        size_t best = 0;
        double best_margin = -std::numeric_limits<double>::infinity(), best_el_deg = 0.0;
        for (size_t s = 0; s < n_stations; ++s) {
            const GroundStation& gs = r.stations[s];
            const StationView v = moon_from_earth_station(moon_ef, deg_to_rad(gs.latitude_deg),
                                                          deg_to_rad(gs.longitude_deg), gs.altitude_m / 1000.0);
            const double el = rad_to_deg(v.elevation_rad), margin = el - gs.min_elevation_deg;
            station_f[s].push_back(margin);
            if (margin > best_margin) best = s, best_margin = margin, best_el_deg = el;
        }
        const GroundStation& gs = r.stations[best];

        // Link budget over the station-to-site range (km -> m), Doppler from its 1 s central difference.
        const double half_s = 0.5 / 86400.0;
        const double range_m = site_range_km(r, gs, jd) * 1000.0;
        const double range_rate_m_s = (site_range_km(r, gs, jd + half_s) - site_range_km(r, gs, jd - half_s)) * 1000.0;
        const double doppler = doppler_shift_hz(range_rate_m_s, r.link.frequency_hz);
        const double margin_db = link_margin_db(r.link, range_m);
        const bool available = earth_margin > 0.0 && best_margin > 0.0 && margin_db > 0.0;

        seconds.push_back(static_cast<double>(t - t0) / 1e6);
        earth_f.push_back(earth_margin);
        budget_f.push_back(margin_db);
        margin_min = std::min(margin_min, margin_db);
        margin_max = std::max(margin_max, margin_db);
        doppler_abs_max = std::max(doppler_abs_max, std::fabs(doppler));
        if (available) earth_el_min_in_link = std::min(earth_el_min_in_link, el_deg);

        samples.push_back({
            {"utc", format_utc(t)},
            {"earth", {{"azimuth_deg", az_deg}, {"elevation_deg", el_deg}}},
            {"earth_visible", earth_margin > 0.0},
            {"station", gs.name},
            {"station_elevation_deg", best_el_deg},
            {"station_visible", best_margin > 0.0},
            {"range_m", range_m},
            {"range_rate_m_s", range_rate_m_s},
            {"doppler_hz", doppler},
            {"fspl_db", fspl_db(range_m, r.link.frequency_hz)},
            {"cn0_dbhz", cn0_dbhz(r.link, range_m)},
            {"ebn0_db", ebn0_db(r.link, range_m)},
            {"margin_db", margin_db},
            {"link_available", available},
        });
    }

    // Each condition is a smooth function of time, so its own crossings are interpolated; the
    // combined windows are then exact set operations on those intervals (SCIENTIFIC_REFERENCE.md
    // section 8) rather than crossings of a kinked max/min, which would invent gaps at handovers.
    const std::vector<Interval> earth_iv = extract_intervals(seconds, earth_f, 0.0);
    std::vector<Interval> all_stations;
    json station_windows = json::array();
    for (size_t s = 0; s < n_stations; ++s) {
        const std::vector<Interval> iv = extract_intervals(seconds, station_f[s], 0.0);
        all_stations.insert(all_stations.end(), iv.begin(), iv.end());
        station_windows.push_back({{"name", r.stations[s].name}, {"windows", windows_json(t0, iv)}});
    }
    const std::vector<Interval> ground_iv = unite(std::move(all_stations), span_s);
    const std::vector<Interval> link_iv = intersect(intersect(earth_iv, ground_iv, span_s),
                                                    extract_intervals(seconds, budget_f, 0.0), span_s);

    // Fractions of the sampled span; undefined (null) for a single-sample grid.
    auto fraction = [&](const std::vector<Interval>& iv) -> json {
        return span_s > 0.0 ? json(covered_seconds(iv) / span_s) : json(nullptr);
    };

    json warns = json::array();
    if (std::fabs(r.scenario.site.latitude_deg) >= POLAR_WARNING_LAT_DEG)
        warns.push_back("|latitude| >= 89.0 deg: azimuth is ill-conditioned near the pole. Convention used: "
                        "local north lies in the meridian plane of the request longitude.");
    if (margin_max <= 0.0)
        warns.push_back("The link budget never closes with these hardware figures (margin <= 0 dB at every "
                        "sample): no link window regardless of geometry.");
    else if (margin_min <= 0.0)
        warns.push_back("The link budget closes only part of the time (margin crosses 0 dB with range).");
    if (earth_el_min_in_link < LOW_ELEVATION_WARNING_DEG)
        warns.push_back("During link windows the Earth is as low as " +
                        std::to_string(earth_el_min_in_link).substr(0, 5) +
                        " deg above the ideal horizon: real terrain can block it and lunar-surface "
                        "multipath (not modelled) can cause deep fades.");
    if (t0 < FIXED_TT_OFFSET_VALID_FROM_US)
        warns.push_back("Epoch before 2017-01-01: the fixed TT - UTC = 69.184 s is off by the leap seconds "
                        "added since (effect on the geometry < 0.01 deg).");

    return {
        {"schema_version", SCHEMA_VERSION},
        {"status", "computed"},
        {"message", "Radio-link windows from an analytic low-precision ephemeris and the request's link "
                    "budget. Engineering estimate, not a link guarantee."},
        {"request", to_json(r)},
        {"model",
         {{"tier", "engineering"},
          {"ephemeris_provider", EPHEMERIS_PROVIDER},
          {"horizon_model", "ideal_geometric"},
          {"body_fixed_frame", "MOON_ME (mean Earth/polar axis; analytic, optical librations only)"},
          {"time_scale_note", "UTC at the API boundary; TT = UTC + 69.184 s (fixed offset, no leap-second "
                              "kernel); UT1 ~= UTC for the Earth's rotation."}}},
        {"data_provenance",
         json::array({
             {{"name", "Meeus, Astronomical Algorithms (2nd ed., 1998), ch. 12, 22, 47, 53"},
              {"kind", "other"},
              {"source", "services/science/src/lunar_ephemeris.cpp"},
              {"version", nullptr},
              {"license", nullptr},
              {"notes", "Truncated ELP-2000/82 series and optical librations. No SPICE kernel, no DEM."}},
             {{"name", "Link-budget formulas"},
              {"kind", "other"},
              {"source", "SCIENTIFIC_REFERENCE.md section 11; services/science/src/link.cpp"},
              {"version", nullptr},
              {"license", nullptr},
              {"notes", "Free-space path loss, C/N0, Eb/N0. Hardware figures and ground stations are "
                        "taken verbatim from the request."}},
         })},
        {"assumptions", ASSUMPTIONS},
        {"warnings", warns},
        {"summary",
         {{"span_hours", span_s / 3600.0},
          {"earth_visible_fraction", fraction(earth_iv)},
          {"ground_station_visible_fraction", fraction(ground_iv)},
          {"link_available_fraction", fraction(link_iv)},
          {"longest_link_outage_hours", longest_gap_seconds(link_iv, span_s) / 3600.0},
          {"link_margin_db_min", margin_min},
          {"link_margin_db_max", margin_max},
          {"max_abs_doppler_hz", doppler_abs_max}}},
        {"samples", samples},
        {"windows",
         {{"earth_visible", windows_json(t0, earth_iv)},
          {"ground_station_visible", windows_json(t0, ground_iv)},
          {"link_available", windows_json(t0, link_iv)},
          {"stations", station_windows}}},
    };
}

}  // namespace selene
