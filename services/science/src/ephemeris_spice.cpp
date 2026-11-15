// SpiceEphemerisProvider: adapter from the standalone CSPICE interface (spice.hpp) to the API's
// EphemerisProvider (JSON model info, provenance, assumptions). No CSPICE call here.

#include "ephemeris.hpp"
#include "spice.hpp"

namespace selene {

struct SpiceState {
    bool ready = false;
    std::string reason;
    json provenance = json::array();
};

SpiceEphemerisProvider::SpiceEphemerisProvider(std::optional<std::filesystem::path> kernel_dir) {
    auto st = std::make_shared<SpiceState>();
    state_ = st;
    // Same reason with or without CSPICE when no directory is configured, so the committed
    // not-ready fixture does not depend on how the service was built.
    if (!kernel_dir) {
        st->reason = "SELENE_KERNEL_DIR not set (see data/README.md, scripts/setup-spice.sh)";
        return;
    }
    if (!spice::available()) {
        st->reason = "CSPICE not linked into this build (run scripts/setup-spice.sh, then reconfigure CMake)";
        return;
    }
    try {
        const spice::KernelSet set = spice::load_kernels(*kernel_dir);
        for (const auto& k : set.files)
            st->provenance.push_back({
                {"name", k.name},
                {"kind", "spice_kernel"},
                {"source", "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/" + k.naif_path},
                {"version", k.name},
                {"license", nullptr},  // the kernels carry no licence statement
                {"notes", k.notes + " Distributed publicly by NASA/JPL NAIF; no licence statement in the file." +
                              (k.sha256 ? " SHA-256 " + *k.sha256 + " (recorded in SHA256SUMS, not recomputed)."
                                        : " No SHA256SUMS entry next to the file.")},
            });
        st->ready = true;
        st->reason = "CSPICE " + spice::toolkit_version() + ", kernels loaded from " + set.dir.string();
    } catch (const spice::Error& e) {
        st->reason = e.what();
    }
}

DirectionSeries SpiceEphemerisProvider::directions(const Site& site, const std::vector<int64_t>& times_us) const {
    if (!state_->ready) throw EphemerisNotReady(state_->reason);
    DirectionSeries d;
    try {
        for (int64_t t : times_us) {
            const double et = spice::utc_to_et(t);
            const spice::AzEl sun = spice::az_el("SUN", et, site.latitude_deg, site.longitude_deg, site.observer_height_m);
            const spice::AzEl earth =
                spice::az_el("EARTH", et, site.latitude_deg, site.longitude_deg, site.observer_height_m);
            d.sun_azimuth_deg.push_back(sun.azimuth_deg);
            d.sun_elevation_deg.push_back(sun.elevation_deg);
            d.earth_azimuth_deg.push_back(earth.azimuth_deg);
            d.earth_elevation_deg.push_back(earth.elevation_deg);
        }
    } catch (const spice::Error& e) {  // e.g. a time outside the kernels' coverage
        throw EphemerisNotReady(e.what());
    }
    return d;
}

ProviderStatus SpiceEphemerisProvider::status() const { return {state_->ready, state_->reason}; }

json SpiceEphemerisProvider::model_info() const {
    json kernels = json::array();
    if (state_->ready)
        for (const auto& k : spice::required_kernels()) kernels.push_back(k.name);
    return {
        {"ephemeris_provider", "spice"},
        {"horizon_model", "ideal_geometric"},
        {"body_fixed_frame", state_->ready ? json(spice::FRAME) : json(nullptr)},
        {"time_scale_note",
         state_->ready ? "UTC at the API boundary; converted to ET (TDB seconds past J2000) by str2et_c with the "
                         "leapseconds kernel naif0012.tls. Leap seconds announced after that kernel are not known."
                       : "UTC at the API boundary; ET (TDB) via the leapseconds kernel once kernels are loaded."},
        {"kernel_set", kernels},
    };
}

json SpiceEphemerisProvider::provenance() const { return state_->ready ? state_->provenance : json::array(); }

std::vector<std::string> SpiceEphemerisProvider::assumptions() const {
    if (!state_->ready) return {};
    return {
        "Ephemerides: JPL DE440 (de440s.bsp) via CSPICE; lunar orientation from moon_pa_de440_200625.bpc.",
        "Body-fixed frame MOON_ME (mean Earth / polar axis, DE421-aligned as in moon_de440_250416.tf, the frame "
        "of LOLA products). Latitude planetocentric, longitude east-positive.",
        "Observer on a 1737.4 km reference sphere plus observer_height_m (converted m -> km); terrain height and "
        "the local slope are ignored.",
        "Directions are to the Sun and Earth centres, corrected for converged light time and stellar aberration "
        "(CN+S) as seen by the observer.",
        "Azimuth from local north toward east in the spherical East-North-Up basis; at |latitude| = 90 deg north "
        "is the horizontal direction along the requested longitude's meridian.",
    };
}

}  // namespace selene
