// Direct-to-Earth radio link: ENGINEERING model tier (SCIENTIFIC_REFERENCE.md section 11).
//
// Pure functions only. Nothing here knows about ephemerides: callers supply the
// observer-to-station range and range rate (from a real ephemeris provider) and every
// hardware figure (EIRP, G/T, losses, data rate, required Eb/N0). No default hardware
// values are provided on purpose: this service must not invent a radio system.
//
// Units: SI at this boundary (m, m/s, Hz, bit/s); logarithmic quantities in dB.
// Callers holding SPICE kilometres must convert km -> m before calling.
//
// Not modelled: antenna pointing loss, polarisation mismatch, multipath from the lunar
// surface at grazing Earth elevation, Earth-side atmosphere/rain, ground-station
// availability and its own horizon mask, coding beyond the single `required_ebn0_db`
// figure. A positive margin is therefore a necessary condition, not a link guarantee.
#pragma once

namespace selene {

constexpr double SPEED_OF_LIGHT_M_S = 299792458.0;  // exact (SI definition)
constexpr double BOLTZMANN_J_PER_K = 1.380649e-23;  // exact (SI 2019 definition)

struct LinkParams {
    double frequency_hz;       // carrier frequency
    double eirp_dbw;           // transmitter EIRP = P_tx + G_tx - transmit-side losses
    double rx_g_over_t_db_k;   // receiver figure of merit G/T, dB/K
    double other_losses_db;    // lumped extra losses (pointing, polarisation, ...), >= 0
    double data_rate_bps;      // information bit rate
    double required_ebn0_db;   // Eb/N0 needed by the chosen modulation/coding
};

// Free-space path loss, dB: 20 log10(4 pi d f / c).
double fspl_db(double range_m, double frequency_hz);

// Carrier-to-noise-density ratio, dB-Hz: EIRP + G/T - FSPL - L_other - 10 log10(k_B).
double cn0_dbhz(const LinkParams& p, double range_m);

// Energy per bit over noise density, dB: C/N0 - 10 log10(R_b).
double ebn0_db(const LinkParams& p, double range_m);

// Eb/N0 minus the required Eb/N0, dB. > 0 means the modelled budget closes.
double link_margin_db(const LinkParams& p, double range_m);

// One-way Doppler shift of the received carrier, Hz, first order in v/c:
// -f * range_rate / c. `range_rate_m_s` > 0 means the range is increasing (receding),
// which lowers the received frequency. Relative error is O(v/c) ~ 1e-5 for lunar links.
double doppler_shift_hz(double range_rate_m_s, double frequency_hz);

}  // namespace selene
