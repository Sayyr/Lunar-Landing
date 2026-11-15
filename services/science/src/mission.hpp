// Surface-stay mission simulation (ENGINEERING tier), mirroring
// packages/contracts/schemas/mission-simulate-{request,response}.schema.json.
//
// Composition only, no new astronomy:
//   * Sun/Earth directions and visibility: evaluate() (SPICE or synthetic provider, ideal or DEM horizon);
//   * direct-to-Earth link windows: evaluate_radio_link() (analytic ephemeris, ideal horizon + mask),
//     intersected with the Earth visibility above the DEM horizon in "dem" mode;
//   * landing-zone slope: slope_check() on a 4 km disc (radius 2000 m) of the finest installed
//     LOLA DEM covering it (20 m south polar, SLDEM2015 ~60 m for 60S-60N, polar 60 m products).
// New here: a solar-array + battery energy balance (SCIENTIFIC_REFERENCE.md section 10), the delay before
// landing, constraint verdicts, resource sizing and corrections.
//
// Energy model (all figures from the request; nothing assumed):
//   P_solar(t) = S0 * A * eta * cos_i(t) when the Sun's centre is above the horizon, else 0, with
//   S0 = 1361 W/m^2 (TSI at 1 AU, Kopp & Lean 2011; the +-3.4 % annual heliocentric-distance variation
//   is NOT applied), cos_i = 1 (sun_tracking), cos(el) (vertical, turned to the Sun's azimuth),
//   max(0, sin(el)) (horizontal). Per step dt (hours): P = mean of the two sample powers (trapezoid);
//   net = P - load; net >= 0 charges eta_c * net * dt (excess over capacity = curtailed), net < 0
//   discharges |net| * dt / eta_d (below empty = unserved load, counted at the load side).
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "ephemeris.hpp"
#include "evaluate.hpp"
#include "intervals.hpp"
#include "models.hpp"
#include "radio.hpp"
#include "terrain.hpp"

namespace selene {

constexpr double SOLAR_CONSTANT_W_M2 = 1361.0;  // TSI at 1 AU, Kopp & Lean (2011)
constexpr double LANDING_DISC_RADIUS_M = 2000.0;  // 4 km landing disc, as the web slope scope

enum class PanelPointing { SunTracking, Vertical, Horizontal };

struct PowerParams {
    double panel_area_m2 = 0, panel_efficiency = 0;
    PanelPointing pointing = PanelPointing::SunTracking;
    double load_w = 0, battery_capacity_wh = 0, battery_initial_soc = 0;
    double charge_efficiency = 1, discharge_efficiency = 1;
};

struct MissionConstraints {
    std::optional<double> min_battery_soc, max_earth_outage_hours, min_contact_hours, min_data_volume_mbit,
        max_slope_deg, min_slope_ok_fraction;
};

struct MissionRequest {
    Site site;
    std::string landing_utc;
    double surface_hours = 0, step_minutes = 0;
    std::string terrain_mode;
    double landing_delay_hours = 0;
    std::string end_policy = "fixed_duration";
    std::optional<double> pre_landing_net_load_w;
    std::optional<PowerParams> power;  // null = energy not modelled (optional, lowest priority)
    std::optional<RadioLinkRequest> radio;  // scenario part filled per simulation
    MissionConstraints constraints;
    double search_max_extra_delay_hours = 360, search_step_hours = 6;
};

// Throws ValidationError with every issue found.
MissionRequest parse_mission_request(const json& body);
json to_json(const MissionRequest& r);

// --- pure pieces (unit-tested) -----------------------------------------------------------------

// Array output (W) for a Sun at elevation el_deg; 0 when not visible.
double solar_power_w(const PowerParams& p, double sun_elevation_deg, bool sun_visible);

struct EnergyResult {
    std::vector<double> solar_w, battery_wh;  // per sample
    double generated_wh = 0, load_wh = 0, unserved_wh = 0, curtailed_wh = 0;
    double min_wh = 0;
    size_t min_index = 0;
    double hours_below_reserve = 0;
    std::optional<size_t> first_below_reserve;  // first sample with battery < reserve
};

// t_s: seconds from landing (increasing); sun_el_deg / sun_visible per sample; e0_wh: battery at landing.
EnergyResult simulate_energy(const std::vector<double>& t_s, const std::vector<double>& sun_el_deg,
                             const std::vector<bool>& sun_visible, const PowerParams& p, double e0_wh,
                             double reserve_wh);

// Sorted disjoint spans (seconds from landing) helpers over [0, total_s].
std::vector<Interval> intersect(const std::vector<Interval>& a, const std::vector<Interval>& b);
double total_seconds(const std::vector<Interval>& spans);
// Longest stretch of [0, total_s] not covered by spans (the whole span when there is none).
double longest_gap_seconds(const std::vector<Interval>& spans, double total_s);
bool covered(const std::vector<Interval>& spans, double t);

// Battery at landing after the delay: soc0 * C - net_load * delay / eta_d, clamped to [0, C].
double battery_at_landing_wh(const PowerParams& p, double delay_hours, std::optional<double> net_load_w);

// --- full simulation ---------------------------------------------------------------------------

struct MissionContext {
    const EphemerisProvider* provider = nullptr;
    TerrainContext terrain;
    // Landing-zone slope check DEMs, finest first (slope_check_any). Empty = not available.
    std::vector<const Dem*> slope_dems;
    std::string slope_unavailable_reason = "no DEM installed";
};

// Full MissionSimulateResponse JSON (corrections included).
json simulate_mission(const MissionRequest& request, const MissionContext& ctx);

}  // namespace selene
