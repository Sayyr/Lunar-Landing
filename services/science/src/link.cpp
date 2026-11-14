#include "link.hpp"

#include <cmath>
#include <stdexcept>
#include <string>

#include "geometry.hpp"

namespace selene {

namespace {

void require_positive(double value, const char* name) {
    if (!(std::isfinite(value) && value > 0.0))
        throw std::invalid_argument(std::string(name) + " must be finite and > 0");
}

void require_finite(double value, const char* name) {
    if (!std::isfinite(value)) throw std::invalid_argument(std::string(name) + " must be finite");
}

void validate(const LinkParams& p) {
    require_positive(p.frequency_hz, "frequency_hz");
    require_positive(p.data_rate_bps, "data_rate_bps");
    require_finite(p.eirp_dbw, "eirp_dbw");
    require_finite(p.rx_g_over_t_db_k, "rx_g_over_t_db_k");
    require_finite(p.required_ebn0_db, "required_ebn0_db");
    if (!(std::isfinite(p.other_losses_db) && p.other_losses_db >= 0.0))
        throw std::invalid_argument("other_losses_db must be finite and >= 0");
}

}  // namespace

double fspl_db(double range_m, double frequency_hz) {
    require_positive(range_m, "range_m");
    require_positive(frequency_hz, "frequency_hz");
    return 20.0 * std::log10(4.0 * PI * range_m * frequency_hz / SPEED_OF_LIGHT_M_S);
}

double cn0_dbhz(const LinkParams& p, double range_m) {
    validate(p);
    return p.eirp_dbw + p.rx_g_over_t_db_k - fspl_db(range_m, p.frequency_hz) - p.other_losses_db -
           10.0 * std::log10(BOLTZMANN_J_PER_K);
}

double ebn0_db(const LinkParams& p, double range_m) {
    return cn0_dbhz(p, range_m) - 10.0 * std::log10(p.data_rate_bps);
}

double link_margin_db(const LinkParams& p, double range_m) {
    return ebn0_db(p, range_m) - p.required_ebn0_db;
}

double doppler_shift_hz(double range_rate_m_s, double frequency_hz) {
    require_finite(range_rate_m_s, "range_rate_m_s");
    require_positive(frequency_hz, "frequency_hz");
    return -frequency_hz * range_rate_m_s / SPEED_OF_LIGHT_M_S;
}

}  // namespace selene
