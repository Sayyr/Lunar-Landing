// Ephemeris providers.
//
// A provider turns (site, UTC sample times) into apparent Sun/Earth directions in the
// observer's local frame. Providers own every frame/time conversion; callers only ever
// see degrees and UTC.
#pragma once

#include <cstdint>
#include <filesystem>
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

// SPICE-backed ephemeris provider — NOT IMPLEMENTED YET.
//
// Planned pipeline (see docs/validation.md), using CSPICE:
// 1. Load a meta-kernel listing LSK (naif00NN.tls), PCK (pck000NN.tpc + moon_pa_*.bpc),
//    FK (moon_*.tf), and SPK (de4xx.bsp) from SELENE_KERNEL_DIR (furnsh_c).
// 2. UTC -> ET (TDB seconds past J2000) via str2et_c using the LSK.
// 3. Observer: planetocentric lat/lon (deg -> rad) and radius (reference radius + height,
//    m -> km) in the chosen body-fixed frame via latrec_c. Proposed frame: MOON_ME
//    (LOLA products use the mean-Earth/polar-axis system) — confirm against DEM metadata.
// 4. Sun/Earth apparent positions from the observer: spkcpo_c(target, et, frame, "OBSERVER",
//    abcorr="LT+S", obspos, "MOON", frame).
// 5. Rotate to local ENU, then azimuth/elevation; deterministic polar convention.
//
// Until then this provider reports itself as not ready and refuses to compute.
class SpiceEphemerisProvider : public EphemerisProvider {
public:
    explicit SpiceEphemerisProvider(std::optional<std::filesystem::path> kernel_dir)
        : kernel_dir_(std::move(kernel_dir)) {}
    std::string kind() const override { return "spice"; }
    bool synthetic() const override { return false; }
    ProviderStatus status() const override;
    json model_info() const override;
    json provenance() const override { return json::array(); }
    std::vector<std::string> assumptions() const override { return {}; }
    DirectionSeries directions(const Site&, const std::vector<int64_t>&) const override {
        throw EphemerisNotReady(status().reason);
    }

private:
    std::optional<std::filesystem::path> kernel_dir_;
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
