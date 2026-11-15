// CSPICE interface (see spice.hpp).

#include "spice.hpp"

#include <cmath>
#include <cstdio>
#include <mutex>

#include "lunar_ephemeris.hpp"
#include "models.hpp"
#include "sha256sums.hpp"

#ifdef SELENE_HAVE_CSPICE
#include <SpiceUsr.h>
#endif

namespace selene::spice {

static_assert(MOON_REFERENCE_RADIUS_KM == MOON_RADIUS_KM, "one lunar reference radius for the whole service");

const std::vector<KernelFile>& required_kernels() {
    static const std::vector<KernelFile> k = {
        {"naif0012.tls", "lsk/naif0012.tls", "Leapseconds kernel (UTC -> ET). Last leap second 2017-01-01.", {}},
        {"de440s.bsp", "spk/planets/de440s.bsp",
         "JPL DE440 planetary ephemeris, short span (1849-12-26 to 2150-01-22).", {}},
        {"pck00011.tpc", "pck/pck00011.tpc", "Generic text PCK (body radii and orientation constants).", {}},
        {"moon_pa_de440_200625.bpc", "pck/moon_pa_de440_200625.bpc",
         "Lunar orientation (MOON_PA_DE440 principal axes) from DE440.", {}},
        {"moon_de440_250416.tf", "fk/satellites/moon_de440_250416.tf",
         "Lunar frames; MOON_ME = MOON_ME_DE440_ME421 (mean Earth / polar axis aligned with DE421, as LOLA).", {}},
    };
    return k;
}

#ifdef SELENE_HAVE_CSPICE

namespace {

// One lock for all CSPICE state. Recursive: public functions call each other.
std::recursive_mutex& mtx() {
    static std::recursive_mutex m;
    return m;
}
using Lock = std::lock_guard<std::recursive_mutex>;

std::optional<std::filesystem::path>& loaded() {
    static std::optional<std::filesystem::path> d;
    return d;
}

// Must hold the lock. RETURN mode, no printing; set once per process.
void init_error_mode() {
    static bool done = false;
    if (done) return;
    erract_c("SET", 0, const_cast<SpiceChar*>("RETURN"));
    errprt_c("SET", 0, const_cast<SpiceChar*>("NONE"));
    done = true;
}

// Must hold the lock. Turns a signalled CSPICE error into spice::Error and resets CSPICE.
void check(const char* what) {
    if (!failed_c()) return;
    SpiceChar msg[1841];
    getmsg_c("LONG", sizeof msg, msg);
    reset_c();
    throw Error(std::string("SPICE error in ") + what + ": " + msg);
}

void require_loaded() {
    if (!loaded()) throw Error("SPICE kernels not loaded (spice::load_kernels)");
}

// "YYYY-MM-DDTHH:MM:SS.ffffff" from UTC microseconds (format_utc gives milliseconds).
std::string iso_utc_us(int64_t us) {
    std::string s = format_utc(us);
    const int64_t sub_ms = ((us % 1000) + 1000) % 1000;
    char tail[4];
    std::snprintf(tail, sizeof tail, "%03lld", static_cast<long long>(sub_ms));
    s.pop_back();  // 'Z'
    return s + tail;
}

}  // namespace

bool available() { return true; }

std::string toolkit_version() { return tkvrsn_c("TOOLKIT"); }

KernelSet load_kernels(const std::filesystem::path& requested) {
    if (!std::filesystem::is_directory(requested))
        throw Error("kernel directory " + requested.string() + " does not exist");
    // Compare directories by their canonical form ("data/kernels/" and "./data/kernels" are the same).
    const std::filesystem::path dir = std::filesystem::weakly_canonical(requested);
    if (!std::filesystem::is_directory(dir)) throw Error("kernel directory " + dir.string() + " does not exist");
    std::string missing;
    for (const auto& k : required_kernels())
        if (!std::filesystem::is_regular_file(dir / k.name)) missing += (missing.empty() ? "" : ", ") + k.name;
    if (!missing.empty())
        throw Error("missing kernels in " + dir.string() + ": " + missing + " (run scripts/setup-spice.sh)");

    Lock lock(mtx());
    init_error_mode();
    if (loaded() && *loaded() != dir)
        throw Error("another kernel directory (" + loaded()->string() + ") is already loaded in this process");
    if (!loaded()) {
        for (const auto& k : required_kernels()) {
            furnsh_c((dir / k.name).string().c_str());
            try {
                check(("furnsh_c " + k.name).c_str());
            } catch (...) {
                kclear_c();  // leave no partial set behind
                throw;
            }
        }
        loaded() = dir;
        try {
            for (double r : moon_radii_km())
                if (std::fabs(r - MOON_REFERENCE_RADIUS_KM) > 1e-6)
                    throw Error("PCK lunar radii differ from the 1737.4 km reference sphere");
        } catch (...) {
            kclear_c();
            loaded().reset();
            throw;
        }
    }
    KernelSet set{dir, required_kernels()};
    for (auto& k : set.files) k.sha256 = sha256_from_sums(dir / "SHA256SUMS", k.name);
    return set;
}

std::optional<std::filesystem::path> loaded_kernel_dir() {
    Lock lock(mtx());
    return loaded();
}

double utc_to_et(const std::string& utc) {
    Lock lock(mtx());
    init_error_mode();
    require_loaded();
    SpiceDouble et = 0;
    str2et_c(utc.c_str(), &et);
    check("str2et_c");
    return et;
}

double utc_to_et(int64_t utc_us) { return utc_to_et(iso_utc_us(utc_us)); }

std::string et_to_utc(double et, int digits) {
    Lock lock(mtx());
    init_error_mode();
    require_loaded();
    SpiceChar out[64];
    et2utc_c(et, "ISOC", digits, sizeof out, out);
    check("et2utc_c");
    return out;
}

Mat3 frame_rotation(const std::string& from, const std::string& to, double et) {
    Lock lock(mtx());
    init_error_mode();
    require_loaded();
    SpiceDouble m[3][3];
    pxform_c(from.c_str(), to.c_str(), et, m);
    check("pxform_c");
    Mat3 r;
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j) r[i][j] = m[i][j];
    return r;
}

std::array<double, 3> moon_radii_km() {
    Lock lock(mtx());
    init_error_mode();
    require_loaded();
    SpiceInt n = 0;
    SpiceDouble r[3];
    bodvrd_c("MOON", "RADII", 3, &n, r);
    check("bodvrd_c MOON RADII");
    if (n != 3) throw Error("PCK MOON RADII does not have 3 values");
    return {r[0], r[1], r[2]};
}

Vec3 site_position_km(double lat_deg, double lon_deg, double height_m) {
    Lock lock(mtx());
    SpiceDouble p[3];
    latrec_c(MOON_REFERENCE_RADIUS_KM + height_m / 1000.0, lon_deg * rpd_c(), lat_deg * rpd_c(), p);
    return {p[0], p[1], p[2]};
}

Apparent apparent_position(const std::string& target, double et, const Vec3& obs) {
    Lock lock(mtx());
    init_error_mode();
    require_loaded();
    SpiceDouble pos[3] = {obs[0], obs[1], obs[2]}, state[6], lt = 0;
    spkcpo_c(target.c_str(), et, FRAME, "OBSERVER", ABCORR, pos, "MOON", FRAME, state, &lt);
    check("spkcpo_c");
    return {{state[0], state[1], state[2]}, lt};
}

AzEl az_el(const std::string& target, double et, double lat_deg, double lon_deg, double height_m) {
    const Apparent a = apparent_position(target, et, site_position_km(lat_deg, lon_deg, height_m));
    const auto [az, el] =
        azimuth_elevation_from_enu(to_enu(enu_basis(deg_to_rad(lat_deg), deg_to_rad(lon_deg)), a.position_km));
    const Vec3& p = a.position_km;
    return {az, el, std::sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2])};
}

AzEl az_el_azlcpo(const std::string& target, double et, double lat_deg, double lon_deg, double height_m) {
    Lock lock(mtx());
    init_error_mode();
    require_loaded();
    const Vec3 o = site_position_km(lat_deg, lon_deg, height_m);
    SpiceDouble pos[3] = {o[0], o[1], o[2]}, azl[6], lt = 0;
    azlcpo_c("ELLIPSOID", target.c_str(), et, ABCORR, SPICEFALSE, SPICETRUE, pos, "MOON", FRAME, azl, &lt);
    check("azlcpo_c");
    return {wrap_azimuth_deg(azl[1] * dpr_c()), azl[2] * dpr_c(), azl[0]};
}

#else  // !SELENE_HAVE_CSPICE

namespace {
[[noreturn]] void unavailable() {
    throw Error("CSPICE not linked into this build (run scripts/setup-spice.sh, then reconfigure CMake)");
}
}  // namespace

bool available() { return false; }
std::string toolkit_version() { unavailable(); }
KernelSet load_kernels(const std::filesystem::path&) { unavailable(); }
std::optional<std::filesystem::path> loaded_kernel_dir() { return std::nullopt; }
double utc_to_et(const std::string&) { unavailable(); }
double utc_to_et(int64_t) { unavailable(); }
std::string et_to_utc(double, int) { unavailable(); }
Mat3 frame_rotation(const std::string&, const std::string&, double) { unavailable(); }
std::array<double, 3> moon_radii_km() { unavailable(); }
Vec3 site_position_km(double, double, double) { unavailable(); }
Apparent apparent_position(const std::string&, double, const Vec3&) { unavailable(); }
AzEl az_el(const std::string&, double, double, double, double) { unavailable(); }
AzEl az_el_azlcpo(const std::string&, double, double, double, double) { unavailable(); }

#endif

}  // namespace selene::spice
