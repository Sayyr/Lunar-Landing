// SpiceEphemerisProvider: CSPICE port of the team's calcul_positions.py (see ephemeris.hpp).

#include <cmath>
#include <cstdio>
#include <mutex>

#include "ephemeris.hpp"
#include "geometry.hpp"
#include "lunar_ephemeris.hpp"
#include "sha256sums.hpp"

#ifdef SELENE_HAVE_CSPICE
#include <SpiceUsr.h>
#endif

namespace selene {

// Same set, same order as calcul_positions.py / test_validation_lunar_mission.py.
const std::vector<std::string> SPICE_KERNELS = {
    "naif0012.tls",              // LSK: UTC <-> ET
    "de440s.bsp",                // SPK: Sun, Earth, Moon (DE440, 1849-2150)
    "pck00011.tpc",              // text PCK: radii (Moon 1737.4 km sphere)
    "moon_pa_de440_200625.bpc",  // binary PCK: high-precision lunar orientation (MOON_PA_DE440)
    "moon_de440_250416.tf",      // FK: MOON_ME / MOON_PA frame definitions
};

struct SpiceState {
    bool ready = false;
    std::string reason;
    std::filesystem::path dir;
    json provenance = json::array();
};

#ifdef SELENE_HAVE_CSPICE

namespace {

struct KernelInfo {
    const char* name;
    const char* naif_dir;  // directory under https://naif.jpl.nasa.gov/pub/naif/generic_kernels/
    const char* notes;
};

const KernelInfo KERNEL_INFO[] = {
    {"naif0012.tls", "lsk", "Leapseconds kernel (UTC -> ET). Last leap second 2017-01-01."},
    {"de440s.bsp", "spk/planets", "JPL DE440 planetary ephemeris, short span (1849-12-26 to 2150-01-22)."},
    {"pck00011.tpc", "pck", "Generic text PCK (body radii and orientation constants)."},
    {"moon_pa_de440_200625.bpc", "pck", "Lunar orientation (MOON_PA_DE440 principal axes) from DE440."},
    {"moon_de440_250416.tf", "fk/satellites",
     "Lunar frames; MOON_ME = MOON_ME_DE440_ME421 (mean Earth / polar axis aligned with DE421, as LOLA)."},
};

}  // namespace

namespace {

std::mutex& spice_mutex() {
    static std::mutex m;
    return m;
}

// Directory currently furnished into this process (CSPICE state is global). Guarded by spice_mutex.
std::optional<std::filesystem::path>& loaded_dir() {
    static std::optional<std::filesystem::path> d;
    return d;
}

// CSPICE error handling in RETURN mode: after each call, turn a signalled error into an exception.
// Must be called with spice_mutex held.
void check_spice(const char* what) {
    if (!failed_c()) return;
    SpiceChar msg[1841];
    getmsg_c("LONG", sizeof msg, msg);
    reset_c();
    throw EphemerisNotReady(std::string("SPICE error in ") + what + ": " + msg);
}

void init_error_mode() {
    static std::once_flag once;
    std::call_once(once, [] {
        erract_c("SET", 0, const_cast<SpiceChar*>("RETURN"));
        errprt_c("SET", 0, const_cast<SpiceChar*>("NONE"));  // no printing to stdout
    });
}

// UTC microseconds since 1970 -> "YYYY-MM-DDTHH:MM:SS.ffffff" (ISO, UTC) for str2et_c.
std::string iso_utc_us(int64_t us) {
    std::string ms = format_utc(us);  // "....SS.mmmZ", millisecond-truncated
    const int64_t sub_ms = ((us % 1000) + 1000) % 1000;
    char tail[4];
    std::snprintf(tail, sizeof tail, "%03lld", static_cast<long long>(sub_ms));
    ms.pop_back();  // drop 'Z'
    return ms + tail;
}

}  // namespace

SpiceEphemerisProvider::SpiceEphemerisProvider(std::optional<std::filesystem::path> kernel_dir) {
    auto st = std::make_shared<SpiceState>();
    state_ = st;
    if (!kernel_dir) {
        st->reason = "SELENE_KERNEL_DIR not set (see data/README.md, scripts/setup-spice.sh)";
        return;
    }
    st->dir = *kernel_dir;
    if (!std::filesystem::is_directory(st->dir)) {
        st->reason = "kernel directory " + st->dir.string() + " does not exist";
        return;
    }
    std::string missing;
    for (const auto& k : SPICE_KERNELS)
        if (!std::filesystem::is_regular_file(st->dir / k)) missing += (missing.empty() ? "" : ", ") + k;
    if (!missing.empty()) {
        st->reason = "missing kernels in " + st->dir.string() + ": " + missing + " (run scripts/setup-spice.sh)";
        return;
    }

    std::lock_guard<std::mutex> lock(spice_mutex());
    init_error_mode();
    try {
        if (loaded_dir() && *loaded_dir() != st->dir)
            throw EphemerisNotReady("another kernel directory (" + loaded_dir()->string() +
                                    ") is already loaded in this process");
        if (!loaded_dir()) {
            for (const auto& k : SPICE_KERNELS) {
                furnsh_c((st->dir / k).string().c_str());
                check_spice(("furnsh_c " + k).c_str());
            }
            loaded_dir() = st->dir;
        }
        SpiceInt n = 0;
        SpiceDouble radii[3];
        bodvrd_c("MOON", "RADII", 3, &n, radii);
        check_spice("bodvrd_c MOON RADII");
        for (double r : radii)
            if (n != 3 || std::fabs(r - MOON_RADIUS_KM) > 1e-6)
                throw EphemerisNotReady("PCK lunar radii differ from the 1737.4 km reference sphere");
    } catch (const EphemerisNotReady& e) {
        st->reason = e.what();
        return;
    }

    for (const auto& k : KERNEL_INFO) {
        auto sha = sha256_from_sums(st->dir / "SHA256SUMS", k.name);
        st->provenance.push_back({
            {"name", k.name},
            {"kind", "spice_kernel"},
            {"source", std::string("https://naif.jpl.nasa.gov/pub/naif/generic_kernels/") + k.naif_dir + "/" + k.name},
            {"version", k.name},
            {"license", nullptr},  // the kernels carry no licence statement
            {"notes", std::string(k.notes) + " Distributed publicly by NASA/JPL NAIF; no licence statement in the file." + (sha ? " SHA-256 " + *sha + " (recorded in SHA256SUMS, not recomputed)."
                                                  : " No SHA256SUMS entry next to the file.")},
        });
    }
    st->ready = true;
    st->reason = "CSPICE " + std::string(tkvrsn_c("TOOLKIT")) + ", kernels loaded from " + st->dir.string();
}

DirectionSeries SpiceEphemerisProvider::directions(const Site& site, const std::vector<int64_t>& times_us) const {
    if (!state_->ready) throw EphemerisNotReady(state_->reason);
    const double lat = deg_to_rad(site.latitude_deg), lon = deg_to_rad(site.longitude_deg);
    const double radius_km = MOON_RADIUS_KM + site.observer_height_m / 1000.0;  // m -> km
    const EnuBasis enu = enu_basis(lat, lon);

    DirectionSeries d;
    std::lock_guard<std::mutex> lock(spice_mutex());
    SpiceDouble obspos[3];
    latrec_c(radius_km, lon, lat, obspos);
    for (int64_t t : times_us) {
        SpiceDouble et = 0;
        str2et_c(iso_utc_us(t).c_str(), &et);
        check_spice("str2et_c");
        for (const char* target : {"SUN", "EARTH"}) {
            SpiceDouble state[6], lt = 0;
            spkcpo_c(target, et, SPICE_FRAME, "OBSERVER", SPICE_ABCORR, obspos, "MOON", SPICE_FRAME, state, &lt);
            check_spice("spkcpo_c");
            auto [az, el] = azimuth_elevation_from_enu(to_enu(enu, {state[0], state[1], state[2]}));
            if (target[0] == 'S') {
                d.sun_azimuth_deg.push_back(az);
                d.sun_elevation_deg.push_back(el);
            } else {
                d.earth_azimuth_deg.push_back(az);
                d.earth_elevation_deg.push_back(el);
            }
        }
    }
    return d;
}

#else  // !SELENE_HAVE_CSPICE

SpiceEphemerisProvider::SpiceEphemerisProvider(std::optional<std::filesystem::path> kernel_dir) {
    auto st = std::make_shared<SpiceState>();
    // Same reason as the CSPICE build when no directory is configured, so the committed not-ready
    // fixture does not depend on how the service was built.
    st->reason = kernel_dir ? "CSPICE not linked into this build (run scripts/setup-spice.sh, then reconfigure CMake)"
                            : "SELENE_KERNEL_DIR not set (see data/README.md, scripts/setup-spice.sh)";
    state_ = st;
}

DirectionSeries SpiceEphemerisProvider::directions(const Site&, const std::vector<int64_t>&) const {
    throw EphemerisNotReady(state_->reason);
}

#endif

ProviderStatus SpiceEphemerisProvider::status() const { return {state_->ready, state_->reason}; }

json SpiceEphemerisProvider::model_info() const {
    json kernels = json::array();
    if (state_->ready)
        for (const auto& k : SPICE_KERNELS) kernels.push_back(k);
    return {
        {"ephemeris_provider", "spice"},
        {"horizon_model", "ideal_geometric"},
        {"body_fixed_frame", state_->ready ? json(SPICE_FRAME) : json(nullptr)},
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
