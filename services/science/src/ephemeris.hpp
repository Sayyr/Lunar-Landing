// Ephemeris providers.
//
// A provider turns (site, UTC sample times) into apparent Sun/Earth directions in the
// observer's local frame. Providers own every frame/time conversion; callers only ever
// see degrees and UTC.
#pragma once

#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "models.hpp"

namespace selene {

// The provider cannot compute (missing kernels, not implemented, ...).
struct EphemerisNotReady : std::runtime_error {
    using std::runtime_error::runtime_error;
};

struct ProviderStatus {
    bool ready;
    std::string reason;
};

// Per-sample topocentric directions, degrees. All vectors have times.size() entries.
struct DirectionSeries {
    std::vector<double> sun_azimuth_deg, sun_elevation_deg;
    std::vector<double> earth_azimuth_deg, earth_elevation_deg;
};

class EphemerisProvider {
public:
    virtual ~EphemerisProvider() = default;
    // Matches ModelInfo.ephemeris_provider.
    virtual std::string kind() const = 0;
    // True if outputs carry no physical meaning. Propagated to ScenarioResponse.synthetic.
    virtual bool synthetic() const = 0;
    virtual ProviderStatus status() const = 0;
    virtual json model_info() const = 0;
    virtual json provenance() const = 0;
    virtual std::vector<std::string> assumptions() const = 0;
    // `times_us`: UTC microseconds since 1970. Throws EphemerisNotReady if it cannot compute.
    virtual DirectionSeries directions(const Site& site, const std::vector<int64_t>& times_us) const = 0;
};

// SPICE-backed ephemeris provider (CSPICE). C++ port of the team's calcul_positions.py, validated
// the same way as test_validation_lunar_mission.py (tests/spice_tests.cpp).
//
// Pipeline (see docs/validation.md):
// 1. Load the fixed kernel set SPICE_KERNELS from SELENE_KERNEL_DIR (furnsh_c), once per process.
//    The PCK lunar radii must equal MOON_RADIUS_KM (1737.4 km sphere), else not ready.
// 2. UTC -> ET (TDB seconds past J2000) via str2et_c with the LSK. Leap seconds after the LSK's
//    last entry are unknown to it (naif0012: last one 2017-01-01).
// 3. Observer in MOON_ME (mean Earth / polar axis; in moon_de440_250416.tf MOON_ME is the
//    DE421-aligned ME frame, the frame of the LOLA products): planetocentric lat/lon (deg -> rad),
//    radius MOON_RADIUS_KM + observer_height_m / 1000 (m -> km), via latrec_c.
// 4. Sun/Earth centres seen from the observer: spkcpo_c(target, et, "MOON_ME", "OBSERVER",
//    "CN+S", obspos, "MOON", "MOON_ME") (converged Newtonian light time + stellar aberration).
// 5. Rotate to the local spherical ENU basis (geometry.hpp enu_basis, deterministic at the poles),
//    then azimuth (from north toward east) / elevation of the body centre.
//
// CSPICE keeps global state and is not thread-safe: every CSPICE call is serialised by one
// process-wide mutex. Only one kernel directory can be loaded per process.
// Built without CSPICE (SELENE_HAVE_CSPICE undefined) the provider always reports not ready.
constexpr const char* SPICE_FRAME = "MOON_ME";
constexpr const char* SPICE_ABCORR = "CN+S";
extern const std::vector<std::string> SPICE_KERNELS;

struct SpiceState;  // loaded kernel set, provenance; defined in ephemeris_spice.cpp

class SpiceEphemerisProvider : public EphemerisProvider {
public:
    explicit SpiceEphemerisProvider(std::optional<std::filesystem::path> kernel_dir);
    std::string kind() const override { return "spice"; }
    bool synthetic() const override { return false; }
    ProviderStatus status() const override;
    json model_info() const override;
    json provenance() const override;
    std::vector<std::string> assumptions() const override;
    // Throws EphemerisNotReady when not ready or when CSPICE signals an error (e.g. a time outside
    // the kernels' coverage).
    DirectionSeries directions(const Site& site, const std::vector<int64_t>& times_us) const override;

private:
    std::shared_ptr<const SpiceState> state_;
};

// SYNTHETIC fixture provider — outputs have NO physical meaning.
//
// Produces smooth, deterministic, arbitrary waveforms so the UI, contracts and window
// extraction can be exercised before real ephemerides exist. Periods and amplitudes are
// deliberately arbitrary (not lunar synodic/libration values) so nobody mistakes them
// for physics.
class SyntheticEphemerisProvider : public EphemerisProvider {
public:
    static constexpr double SUN_PERIOD_H = 36.0;
    static constexpr double EARTH_PERIOD_H = 60.0;

    std::string kind() const override { return "synthetic_fixture"; }
    bool synthetic() const override { return true; }
    ProviderStatus status() const override {
        return {true, "synthetic waveforms, no physical meaning"};
    }
    json model_info() const override;
    json provenance() const override;
    std::vector<std::string> assumptions() const override;
    DirectionSeries directions(const Site& site, const std::vector<int64_t>& times_us) const override;
};

}  // namespace selene
