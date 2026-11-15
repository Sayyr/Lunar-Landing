#include "terrain.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <limits>
#include <sstream>
#include <stdexcept>

#include "dem_label.hpp"
#include "sha256sums.hpp"

namespace selene {

namespace fs = std::filesystem;
using slope::DEG;

namespace {

constexpr float NaNf = std::numeric_limits<float>::quiet_NaN();
constexpr double IMPLAUSIBLE_KM = 100.0;  // same no-data rule as tools/slope_tiles.cpp
constexpr double EXTREME_SLOPE_DEG = 50.0;

float clean_height(float v) { return std::isfinite(v) && std::fabs(v) <= IMPLAUSIBLE_KM ? v : NaNf; }

class PdsDem final : public Dem {
public:
    PdsDem(DemInfo info, fs::path img, double scaling) : Dem(std::move(info)), img_(std::move(img)), scaling_(scaling) {}

    void read_window(int l0, int s0, int nl, int ns, float* out) const override {
        std::fill(out, out + static_cast<std::size_t>(nl) * ns, NaNf);
        const int s_lo = std::max(s0, 0), s_hi = std::min(s0 + ns, info_.samples);
        if (s_lo >= s_hi) return;
        // One stream per call: concurrent requests on httplib's thread pool never share state.
        std::ifstream f(img_, std::ios::binary);
        if (!f) throw std::runtime_error("cannot open DEM " + img_.string());
        std::vector<float> row(static_cast<std::size_t>(s_hi - s_lo));
        for (int l = std::max(l0, 0); l < std::min(l0 + nl, info_.lines); ++l) {
            const std::streamoff off = (static_cast<std::streamoff>(l) * info_.samples + s_lo) * 4;
            f.seekg(off);
            f.read(reinterpret_cast<char*>(row.data()), static_cast<std::streamsize>(row.size() * 4));
            if (!f) throw std::runtime_error("DEM read failed at line " + std::to_string(l));
            float* dst = out + static_cast<std::size_t>(l - l0) * ns + (s_lo - s0);
            for (std::size_t i = 0; i < row.size(); ++i) dst[i] = clean_height(static_cast<float>(row[i] * scaling_));
        }
    }

private:
    fs::path img_;
    double scaling_;
};

class MemoryDem final : public Dem {
public:
    MemoryDem(DemInfo info, std::vector<float> h) : Dem(std::move(info)), h_(std::move(h)) {
        if (h_.size() != static_cast<std::size_t>(info_.lines) * info_.samples)
            throw std::invalid_argument("in-memory DEM size does not match lines x samples");
    }
    void read_window(int l0, int s0, int nl, int ns, float* out) const override {
        for (int l = 0; l < nl; ++l)
            for (int s = 0; s < ns; ++s) {
                const int L = l0 + l, S = s0 + s;
                const bool in = L >= 0 && S >= 0 && L < info_.lines && S < info_.samples;
                out[static_cast<std::size_t>(l) * ns + s] =
                    in ? clean_height(h_[static_cast<std::size_t>(L) * info_.samples + S]) : NaNf;
            }
    }

private:
    std::vector<float> h_;
};

// SLDEM2015 tiles assembled into one global simple cylindrical grid; the sample index wraps at 360 deg.
class SldemMosaic final : public Dem {
public:
    struct Tile {
        fs::path img;
        int l0, s0, lines, samples;  // position in the global grid
        double scaling;
    };
    SldemMosaic(DemInfo info, std::vector<Tile> tiles) : Dem(std::move(info)), tiles_(std::move(tiles)) {}

    void read_window(int l0, int s0, int nl, int ns, float* out) const override {
        std::fill(out, out + static_cast<std::size_t>(nl) * ns, NaNf);
        const int total = info_.samples;
        std::vector<float> row;
        for (const Tile& t : tiles_) {
            const int la = std::max({l0, t.l0, 0}), lb = std::min({l0 + nl, t.l0 + t.lines, info_.lines});
            if (la >= lb) continue;
            std::ifstream f;  // opened on first use; one stream per call (thread-safe)
            for (int k = -1; k <= 1; ++k) {  // the window may straddle the 0 / 360 deg seam
                const int ta = t.s0 + k * total, tb = ta + t.samples;
                const int sa = std::max(s0, ta), sb = std::min(s0 + ns, tb);
                if (sa >= sb) continue;
                if (!f.is_open()) {
                    f.open(t.img, std::ios::binary);
                    if (!f) throw std::runtime_error("cannot open DEM tile " + t.img.string());
                }
                row.resize(static_cast<std::size_t>(sb - sa));
                for (int l = la; l < lb; ++l) {
                    const std::streamoff off = (static_cast<std::streamoff>(l - t.l0) * t.samples + (sa - ta)) * 4;
                    f.seekg(off);
                    f.read(reinterpret_cast<char*>(row.data()), static_cast<std::streamsize>(row.size() * 4));
                    if (!f) throw std::runtime_error("DEM tile read failed: " + t.img.filename().string());
                    float* dst = out + static_cast<std::size_t>(l - l0) * ns + (sa - s0);
                    for (std::size_t i = 0; i < row.size(); ++i)
                        dst[i] = clean_height(static_cast<float>(row[i] * t.scaling));
                }
            }
        }
    }

    bool covers(int line, int sample) const override {
        const int total = info_.samples;
        const int S = ((sample % total) + total) % total;
        for (const Tile& t : tiles_)
            if (line >= t.l0 && line < t.l0 + t.lines && S >= t.s0 && S < t.s0 + t.samples) return true;
        return false;
    }

private:
    std::vector<Tile> tiles_;
};

// Pixel centre -> unit vector on the reference sphere, plus planetocentric lat/lon (deg).
struct Surface {
    std::array<double, 3> u;
    double lat_deg, lon_deg;
};

double wrap180(double lon) {
    lon = std::fmod(lon + 180.0, 360.0);
    if (lon < 0) lon += 360.0;
    return lon - 180.0;
}

std::array<double, 3> unit_of(double lat_deg, double lon_deg) {
    const double la = lat_deg / DEG, lo = lon_deg / DEG;
    return {std::cos(la) * std::cos(lo), std::cos(la) * std::sin(lo), std::sin(la)};
}

Surface surface_of(const DemInfo& d, double line, double sample) {
    if (d.grid == DemGrid::cylindrical) {
        const double lat = (d.proj.line_off - line) / d.ppd, lon = (sample - d.proj.sample_off) / d.ppd;
        return {unit_of(lat, lon), lat, wrap180(lon)};
    }
    const slope::MapXY m = slope::map_xy(d.proj, line, sample);
    const double c = 2.0 * std::atan(std::hypot(m.x, m.y) / (2.0 * d.proj.radius_m));  // colatitude from the pole
    const double lon = d.center_lon_deg / DEG + slope::relative_lon_rad(d.proj, line, sample);
    const bool north = d.grid == DemGrid::polar_north;
    return {{std::sin(c) * std::cos(lon), std::sin(c) * std::sin(lon), north ? std::cos(c) : -std::cos(c)},
            north ? 90.0 - c * DEG : c * DEG - 90.0,
            wrap180(lon * DEG)};
}

// Ground spacing (m, on the reference sphere) between pixel centres along "up" (north) of a
// cylindrical grid; east-west spacing is this times cos(latitude).
double cyl_spacing_m(const DemInfo& d) { return d.proj.radius_m / (d.ppd * DEG); }

// Central angle via atan2(|a x b|, a . b): accurate for the metre-scale separations used here.
double central_angle(const std::array<double, 3>& a, const std::array<double, 3>& b) {
    const double cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0];
    return std::atan2(std::sqrt(cx * cx + cy * cy + cz * cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
}

std::string fmt(double v, const char* f = "%g") {
    char buf[64];
    std::snprintf(buf, sizeof buf, f, v);
    return buf;
}

std::string projection_text(const DemInfo& d) {
    const std::string R = fmt(d.proj.radius_m / 1000.0);
    if (d.grid == DemGrid::cylindrical)
        return "simple cylindrical, sphere R = " + R + " km, " + fmt(d.ppd) + " pixels per degree";
    return "polar stereographic, sphere R = " + R + " km, true scale at the pole, centre " +
           (d.grid == DemGrid::polar_north ? "90N " : "90S ") + fmt(d.center_lon_deg) + "E";
}

json model_json(const Dem* dem) {
    if (!dem) return {{"method", "horn_3x3_native_grid"}, {"baseline_m", nullptr}, {"body_fixed_frame", nullptr}, {"projection", nullptr}};
    const DemInfo& d = dem->info();
    return {{"method", "horn_3x3_native_grid"},
            {"baseline_m", d.proj.scale_m},
            {"body_fixed_frame", d.frame},
            {"projection", projection_text(d)}};
}

json str_or_null(const std::string& s) { return s.empty() ? json(nullptr) : json(s); }

json provenance_json(const Dem* dem, const std::string& reason) {
    if (!dem) return {{"dem_product", "none"}, {"dem_sha256", nullptr}, {"reason", reason}};
    const DemInfo& d = dem->info();
    json p = {{"dem_product", d.product_id}, {"dem_sha256", d.sha256 ? json(*d.sha256) : json(nullptr)},
              {"dem_sha256_note", d.sha256_note}, {"file", d.file}, {"synthetic", d.synthetic}};
    if (!d.synthetic) {
        // Copied from the .LBL; null when the label does not state it. Nothing is filled in.
        p["product_version"] = str_or_null(d.product_version);
        p["data_set_id"] = str_or_null(d.data_set_id);
        p["producer_id"] = str_or_null(d.producer_id);
        p["producer_full_name"] = str_or_null(d.producer_full_name);
        p["producer_institution_name"] = str_or_null(d.producer_institution_name);
        p["product_creation_time"] = str_or_null(d.product_creation_time);
        p["instrument_host_name"] = str_or_null(d.instrument_host_name);
        p["instrument_id"] = str_or_null(d.instrument_id);
        p["time_coverage"] = str_or_null(d.time_coverage);
        if (d.lola_gdr) {
            p["producer"] = "LRO LOLA team, NASA GSFC; PDS Geosciences Node";
            p["url"] = d.grid == DemGrid::cylindrical
                           ? "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/sldem2015/tiles/float_img/"
                           : "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/";
            p["license"] = "NASA PDS data, public; credit NASA/GSFC LOLA team";
        } else {
            p["url"] = nullptr;
            p["license"] = nullptr;
        }
    }
    p["grid"] = {{"lines", d.lines}, {"samples", d.samples}, {"map_scale_m", d.proj.scale_m},
                 {"line_projection_offset", d.proj.line_off}, {"sample_projection_offset", d.proj.sample_off},
                 {"maximum_latitude_deg", d.max_latitude_deg ? json(*d.max_latitude_deg) : json(nullptr)},
                 {"minimum_latitude_deg", d.min_latitude_deg ? json(*d.min_latitude_deg) : json(nullptr)},
                 {"projection", projection_text(d)}};
    return p;
}

json assumptions_json(const DemInfo& d) {
    const std::string R = fmt(d.proj.radius_m / 1000.0);
    const bool cyl = d.grid == DemGrid::cylindrical;
    return json::array({
        "Input latitude is planetocentric and longitude east-positive in the DEM's body-fixed frame (" + d.frame +
            "); no frame conversion is applied.",
        "Zone = DEM pixels whose centre (exact inverse " + std::string(cyl ? "simple cylindrical" : "polar stereographic") +
            ") lies within radius_m great-circle distance of the zone centre on the " + R +
            " km reference sphere; terrain height is ignored for selection.",
        cyl ? "Per-pixel slope: Horn (1981) 3x3 finite differences on the native " + fmt(d.ppd) +
                  " pixel/degree grid, north-south spacing R * (1 / ppd) deg and east-west spacing R * cos(lat) * "
                  "(1 / ppd) deg, both scaled by (R + h) / R (slope::horn_slope_xy in slope_core.hpp)."
            : "Per-pixel slope: Horn (1981) 3x3 finite differences on the native " + fmt(d.proj.scale_m) +
                  " m grid, ground spacing = map_scale / k * (R + h) / R with k = 1 + (rho / 2R)^2 "
                  "(services/science/src/slope_core.hpp, identical to the web slope tiles at level 0).",
        "Slope is measured from the reference-sphere radial direction, not the local gravity (geoid) normal.",
        "No-data: non-finite or |h| > 100 km heights, or any no-data in the 3x3 window; never treated as flat. "
        "Every zone pixel must have a full 3x3 window inside the grid, lie within the label's declared "
        "MINIMUM/MAXIMUM_LATITUDE and (mosaic) in an installed tile, else status = out_of_coverage.",
        "fraction_ok = valid pixels with slope <= max_slope_deg / valid pixels. verdict = insufficient_data if "
        "nodata_count / pixel_count > max_nodata_fraction (or no valid pixel), else pass iff fraction_ok >= "
        "required_fraction, else fail.",
        "slope_p95_deg is the nearest-rank 95th percentile of valid pixel slopes; worst_pixel is the steepest "
        "valid pixel (first in raster order on ties).",
    });
}

json base_warnings(const DemInfo& d) {
    json w = json::array();
    if (d.synthetic)
        w.push_back("SYNTHETIC DEM: this result comes from a test grid, not from lunar data.");
    w.push_back("Slope at the DEM's " + fmt(d.proj.scale_m) + " m grid (Horn window ~" + fmt(3 * d.proj.scale_m) +
                " m) is NOT lander-footprint slope: boulders, small craters and roughness below the DEM resolution "
                "are invisible, and slopes at lander scale are generally steeper. A pass is a DEM-scale screening "
                "result, not a validated or certified landing site.");
    if (!d.synthetic && d.lola_gdr && d.grid != DemGrid::cylindrical)
        w.push_back("The LOLA polar DEM is interpolated between laser tracks (GMT 'surface'): sparse-track areas are "
                    "smoothed (can hide slopes) and isolated slopes > 50 deg can be interpolation artefacts.");
    if (!d.synthetic && d.lola_gdr && d.grid == DemGrid::cylindrical)
        w.push_back("SLDEM2015 combines LOLA laser altimetry with SELENE (Kaguya) Terrain Camera stereo terrain "
                    "(label DESCRIPTION): stereo-matching artefacts can create or hide slopes at the pixel scale, and "
                    "its ~" + fmt(d.proj.scale_m, "%.0f") + " m pixel is coarser than the 20 m polar product.");
    if (!d.synthetic && !d.lola_gdr)
        w.push_back("DEM origin and license are not recorded: the label does not identify an LRO LOLA GDR product "
                    "(DATA_SET_ID " + (d.data_set_id.empty() ? std::string("absent") : "\"" + d.data_set_id + "\"") +
                    "). data_provenance lists only what the label states; its gridding/interpolation method is "
                    "unknown to this service.");
    return w;
}

// Simple cylindrical tile: checks the label offsets against the PDS pixel-registered convention
// (0-based line = LINE_OFFSET - lat * ppd, sample = SAMPLE_OFFSET + (lon - CENTER_LONGITUDE) * ppd,
// the first pixel's outer edge at MAXIMUM_LATITUDE / WESTERNMOST_LONGITUDE) and stores the grid as
// line = proj.line_off - lat * ppd, sample = proj.sample_off + lon * ppd. Throws on any mismatch.
void set_cylindrical(DemInfo& d, const dem::Label& lab) {
    const double ppd = *lab.map_resolution, top = *lab.maximum_latitude, bottom = *lab.minimum_latitude;
    const double west = *lab.westernmost_longitude, east = *lab.easternmost_longitude;
    const auto near = [](double a, double b) { return std::fabs(a - b) < 1e-6; };
    if (!near(lab.line_off - top * ppd, -0.5) || !near(lab.sample_off + (west - lab.center_lon) * ppd, -0.5) ||
        !near((top - bottom) * ppd, lab.lines) || !near((east - west) * ppd, lab.samples))
        throw std::runtime_error("simple cylindrical label " + lab.product_id +
                                 ": offsets/extent do not match the pixel-registered convention");
    d.grid = DemGrid::cylindrical;
    d.ppd = ppd;
    d.proj.line_off = top * ppd - 0.5;
    d.proj.sample_off = -west * ppd - 0.5;
    d.wraps_lon = near(east - west, 360.0);
    d.center_lon_deg = 0;
}

void copy_label_metadata(DemInfo& d, const dem::Label& lab) {
    d.product_version = lab.product_version_id;
    d.data_set_id = lab.data_set_id;
    d.frame = lab.frame;
    d.producer_id = lab.producer_id;
    d.producer_full_name = lab.producer_full_name;
    d.producer_institution_name = lab.producer_institution_name;
    d.product_creation_time = lab.product_creation_time;
    d.instrument_host_name = lab.instrument_host_name;
    d.instrument_id = lab.instrument_id;
    d.lola_gdr = dem::is_lola_gdr(lab);
    if (!lab.start_time.empty() || !lab.stop_time.empty())
        d.time_coverage = (lab.start_time.empty() ? "?" : lab.start_time) + "/" +
                          (lab.stop_time.empty() ? "?" : lab.stop_time) + " (label START_TIME/STOP_TIME)";
}

}  // namespace

// ---------- DEM sources ----------

std::shared_ptr<const Dem> Dem::open_pds(const fs::path& img, const fs::path& lbl) {
    const std::uint16_t one = 1;
    if (*reinterpret_cast<const unsigned char*>(&one) != 1) throw std::runtime_error("big-endian host unsupported");
    const dem::Label lab = dem::parse_label_any(lbl);
    const std::uintmax_t expect = static_cast<std::uintmax_t>(lab.lines) * lab.samples * 4;
    std::error_code ec;
    const std::uintmax_t size = fs::file_size(img, ec);
    if (ec) throw std::runtime_error("cannot stat " + img.string() + ": " + ec.message());
    if (size != expect)
        throw std::runtime_error("image size " + std::to_string(size) + " does not match label (" +
                                 std::to_string(expect) + " bytes)");
    DemInfo d;
    d.proj.radius_m = lab.radius_km * 1000.0;
    d.proj.line_off = lab.line_off;
    d.proj.sample_off = lab.sample_off;
    d.proj.scale_m = lab.scale_m;
    d.lines = lab.lines;
    d.samples = lab.samples;
    d.center_lon_deg = lab.center_lon;
    d.max_latitude_deg = lab.maximum_latitude;
    d.min_latitude_deg = lab.minimum_latitude;
    if (lab.cylindrical()) {
        set_cylindrical(d, lab);
    } else {
        // South: same validated signs as slope-tiles / apps/web polar_s (see slope_core.hpp).
        // North (PDS polar stereographic): x = rho sin(lon - lon0), y = -rho cos(lon - lon0), so lon0
        // points down the image; checked against the global LOLA grid (docs/validation.md).
        d.grid = lab.center_lat > 0 ? DemGrid::polar_north : DemGrid::polar_south;
        d.proj.sign_y = d.grid == DemGrid::polar_north ? -1 : 1;
        d.proj.sign_line = -1;
    }
    d.product_id = lab.product_id;
    d.file = img.filename().string();
    copy_label_metadata(d, lab);
    d.sha256 = sha256_from_sums(img.parent_path() / "SHA256SUMS", img.filename().string());
    d.sha256_note = d.sha256 ? "read from SHA256SUMS next to the file at startup; not recomputed by the service"
                             : "no SHA256SUMS entry next to the file";
    const auto mtime = fs::last_write_time(img, ec);
    d.identity = d.product_id + "|" + std::to_string(size) + "|" +
                 (ec ? std::string("?") : std::to_string(static_cast<long long>(mtime.time_since_epoch().count()))) + "|" +
                 d.sha256.value_or("no-sha256");
    return std::make_shared<PdsDem>(std::move(d), img, lab.scaling);
}

std::shared_ptr<const Dem> Dem::open_pds_auto(const fs::path& img, const std::optional<fs::path>& lbl) {
    if (lbl) return open_pds(img, *lbl);
    for (const char* ext : {".lbl", ".LBL"}) {
        fs::path cand = img;
        cand.replace_extension(ext);
        if (fs::exists(cand)) return open_pds(img, cand);
    }
    throw std::runtime_error("no .lbl/.LBL label next to " + img.string() + " (set SELENE_DEM_LABEL)");
}

std::shared_ptr<const Dem> Dem::open_sldem_dir(const fs::path& dir) {
    struct Found {
        fs::path img;
        dem::Label lab;
    };
    std::vector<Found> found;
    std::error_code ec;
    for (const auto& e : fs::directory_iterator(dir, ec)) {
        std::string name = e.path().filename().string();
        std::transform(name.begin(), name.end(), name.begin(), [](unsigned char ch) { return std::tolower(ch); });
        if (name.rfind("sldem2015_", 0) != 0 || name.size() < 10 || name.substr(name.size() - 10) != "_float.img") continue;
        fs::path lbl;
        for (const char* ext : {".lbl", ".LBL"}) {
            fs::path cand = e.path();
            cand.replace_extension(ext);
            if (fs::exists(cand)) lbl = cand;
        }
        if (lbl.empty()) throw std::runtime_error("no label next to " + e.path().string());
        found.push_back({e.path(), dem::parse_label_any(lbl)});
    }
    if (ec) throw std::runtime_error("cannot list " + dir.string() + ": " + ec.message());
    if (found.empty()) throw std::runtime_error("no sldem2015_*_float.img tile in " + dir.string());
    std::sort(found.begin(), found.end(), [](const Found& a, const Found& b) { return a.img.filename() < b.img.filename(); });

    const dem::Label& first = found.front().lab;
    double top = -90, bottom = 90;
    for (const Found& f : found) {
        const dem::Label& l = f.lab;
        if (!l.cylindrical() || *l.map_resolution != *first.map_resolution || l.radius_km != first.radius_km ||
            l.frame != first.frame)
            throw std::runtime_error("SLDEM tile " + l.product_id + " is not on the same cylindrical grid as " +
                                     first.product_id);
        const std::uintmax_t size = fs::file_size(f.img, ec);
        if (ec || size != static_cast<std::uintmax_t>(l.lines) * l.samples * 4)
            throw std::runtime_error("SLDEM tile " + f.img.filename().string() + ": size does not match its label");
        top = std::max(top, *l.maximum_latitude);
        bottom = std::min(bottom, *l.minimum_latitude);
    }
    const double ppd = *first.map_resolution;
    DemInfo d;
    d.grid = DemGrid::cylindrical;
    d.ppd = ppd;
    d.wraps_lon = true;
    d.proj.radius_m = first.radius_km * 1000.0;
    d.proj.scale_m = first.scale_m;
    d.proj.line_off = top * ppd - 0.5;
    d.proj.sample_off = -0.5;
    d.lines = static_cast<int>(std::lround((top - bottom) * ppd));
    d.samples = static_cast<int>(std::lround(360.0 * ppd));
    d.max_latitude_deg = top;
    d.min_latitude_deg = bottom;
    copy_label_metadata(d, first);
    d.product_id = "SLDEM2015_" + fmt(ppd) + " mosaic";
    d.file = std::to_string(found.size()) + " tile(s) in " + dir.filename().string() + "/";

    std::vector<SldemMosaic::Tile> tiles;
    std::size_t hashed = 0;
    d.identity = d.product_id;
    for (const Found& f : found) {
        DemInfo t;  // validates the tile's own offsets (throws on mismatch)
        set_cylindrical(t, f.lab);
        const int l0 = static_cast<int>(std::lround((top - *f.lab.maximum_latitude) * ppd));
        const int s0 = static_cast<int>(std::lround(*f.lab.westernmost_longitude * ppd));
        tiles.push_back({f.img, l0, s0, f.lab.lines, f.lab.samples, f.lab.scaling});
        const auto sha = sha256_from_sums(dir / "SHA256SUMS", f.img.filename().string());
        hashed += sha.has_value();
        const auto mtime = fs::last_write_time(f.img, ec);
        d.identity += "|" + f.img.filename().string() + ":" + std::to_string(fs::file_size(f.img)) + ":" +
                      (ec ? std::string("?") : std::to_string(static_cast<long long>(mtime.time_since_epoch().count()))) +
                      ":" + sha.value_or("-");
    }
    d.sha256_note = std::to_string(hashed) + " of " + std::to_string(found.size()) +
                    " tiles have a SHA256SUMS entry (per-tile hashes, recorded not recomputed)";
    return std::make_shared<SldemMosaic>(std::move(d), std::move(tiles));
}

std::shared_ptr<const Dem> Dem::in_memory(DemInfo info, std::vector<float> heights_km) {
    if (info.identity.empty()) info.identity = "in-memory|" + info.product_id;
    return std::make_shared<MemoryDem>(std::move(info), std::move(heights_km));
}

GridPos dem_pixel_of(const DemInfo& d, double lat_deg, double lon_deg) {
    if (d.grid == DemGrid::cylindrical) {
        double lon = std::fmod(lon_deg, 360.0);
        if (lon < 0) lon += 360.0;
        return {d.proj.line_off - lat_deg * d.ppd, d.proj.sample_off + lon * d.ppd};
    }
    // colatitude from the projection pole
    const double c = (d.grid == DemGrid::polar_north ? 90.0 - lat_deg : 90.0 + lat_deg) / DEG;
    const double rho = 2.0 * d.proj.radius_m * std::tan(c / 2.0);
    const double dl = (lon_deg - d.center_lon_deg) / DEG;
    const double x = rho * std::sin(dl), y = d.proj.sign_y * rho * std::cos(dl);
    return {d.proj.line_off + d.proj.sign_line * y / d.proj.scale_m, d.proj.sample_off + x / d.proj.scale_m};
}

LatLon dem_latlon_of(const DemInfo& d, double line, double sample) {
    const Surface s = surface_of(d, line, sample);
    return {s.lat_deg, s.lon_deg};
}

// ---------- request ----------

SlopeCheckRequest parse_slope_check_request(const json& body) {
    using namespace validate;
    if (!body.is_object()) throw ValidationError(std::vector<ErrorDetail>{{"", NOT_OBJECT}});
    std::vector<ErrorDetail> errs;
    SlopeCheckRequest r;
    auto zone = body.find("zone");
    if (zone == body.end()) {
        errs.push_back({"zone", "Field required"});
    } else if (!zone->is_object()) {
        errs.push_back({"zone", NOT_OBJECT});
    } else {
        read_number(*zone, "center_latitude_deg", "zone.center_latitude_deg", {{Limit::GE, -90}, {Limit::LE, 90}},
                    r.center_latitude_deg, errs);
        read_number(*zone, "center_longitude_deg", "zone.center_longitude_deg",
                    {{Limit::GE, -180}, {Limit::LT, 180}}, r.center_longitude_deg, errs);
        read_number(*zone, "radius_m", "zone.radius_m", {{Limit::GE, 20}, {Limit::LE, 10000}}, r.radius_m, errs);
        reject_extra(*zone, {"center_latitude_deg", "center_longitude_deg", "radius_m"}, "zone.", errs);
    }
    read_number(body, "max_slope_deg", "max_slope_deg", {{Limit::GT, 0}, {Limit::LE, 90}}, r.max_slope_deg, errs);
    if (body.contains("required_fraction"))
        read_number(body, "required_fraction", "required_fraction", {{Limit::GE, 0}, {Limit::LE, 1}},
                    r.required_fraction, errs);
    if (body.contains("max_nodata_fraction"))
        read_number(body, "max_nodata_fraction", "max_nodata_fraction", {{Limit::GE, 0}, {Limit::LE, 1}},
                    r.max_nodata_fraction, errs);
    reject_extra(body, {"zone", "max_slope_deg", "required_fraction", "max_nodata_fraction"}, "", errs);
    if (!errs.empty()) throw ValidationError(std::move(errs));
    return r;
}

json to_json(const SlopeCheckRequest& r) {
    return {{"zone",
             {{"center_latitude_deg", r.center_latitude_deg},
              {"center_longitude_deg", r.center_longitude_deg},
              {"radius_m", r.radius_m}}},
            {"max_slope_deg", r.max_slope_deg},
            {"required_fraction", r.required_fraction},
            {"max_nodata_fraction", r.max_nodata_fraction}};
}

std::string slope_cache_key(const SlopeCheckRequest& r, const DemInfo& d) {
    return to_json(r).dump() + "\n" + d.identity;
}

// ---------- slope check ----------

json slope_check(const SlopeCheckRequest& req, const Dem* dem, const std::string& unavailable_reason) {
    json out = {{"status", "dem_unavailable"}, {"verdict", "not_evaluated"}, {"request", to_json(req)},
                {"stats", nullptr},           {"model", model_json(dem)},   {"data_provenance", provenance_json(dem, unavailable_reason)},
                {"assumptions", json::array()}, {"warnings", json::array()}};
    if (!dem) {
        out["warnings"].push_back("No DEM loaded in the science service: " + unavailable_reason +
                                  ". No slope was computed.");
        return out;
    }
    const DemInfo& d = dem->info();
    out["assumptions"] = assumptions_json(d);
    out["warnings"] = base_warnings(d);
    if (std::fabs(req.center_latitude_deg) == 90.0)
        out["warnings"].push_back("Zone centred exactly on the pole: center_longitude_deg is ignored.");

    auto out_of_coverage = [&](const std::string& why) {
        out["status"] = "out_of_coverage";
        out["warnings"].push_back("Zone not fully inside the " + d.product_id + " coverage: " + why +
                                  ". No slope was computed.");
        return out;
    };

    const GridPos c = dem_pixel_of(d, req.center_latitude_deg, req.center_longitude_deg);
    // A <= 10 km zone spans at most a few hundred pixels: a centre this far off the grid is out (and
    // keeps the integer conversions below safe, e.g. latitude +90 maps to rho ~ 1e16 m).
    if (!std::isfinite(c.line) || !std::isfinite(c.sample) || std::fabs(c.line) > 4.0 * d.lines ||
        std::fabs(c.sample) > 4.0 * d.samples)
        return out_of_coverage("zone centre is far outside the DEM grid");

    const bool cyl = d.grid == DemGrid::cylindrical;
    int half_l, half_s;
    if (cyl) {
        // One line spans R / ppd (deg) on the ground, one sample that times cos(lat): size the box with
        // the zone's highest |latitude|. Cylindrical products here stop well short of the poles.
        const double lat_max = std::min(89.0, std::fabs(req.center_latitude_deg) + req.radius_m / d.proj.radius_m * DEG);
        half_l = static_cast<int>(std::ceil(req.radius_m / cyl_spacing_m(d))) + 1;
        half_s = static_cast<int>(std::ceil(req.radius_m / (cyl_spacing_m(d) * std::cos(lat_max / DEG)))) + 1;
    } else {
        // Map distance <= k_max * ground distance on the sphere, so this box holds every zone pixel.
        const slope::MapXY mc = slope::map_xy(d.proj, c.line, c.sample);
        const double k_max = slope::scale_factor(std::hypot(mc.x, mc.y) + 2.0 * req.radius_m + 2.0 * d.proj.scale_m,
                                                 d.proj.radius_m);
        half_l = half_s = static_cast<int>(std::ceil(req.radius_m * k_max / d.proj.scale_m)) + 1;
    }
    const int L0 = static_cast<int>(std::lround(c.line)) - half_l, L1 = static_cast<int>(std::lround(c.line)) + half_l;
    const int S0 = static_cast<int>(std::lround(c.sample)) - half_s, S1 = static_cast<int>(std::lround(c.sample)) + half_s;
    const int bl = L1 - L0 + 1, bs = S1 - S0 + 1;

    // Pass 1: zone mask and coverage (no I/O).
    const auto u0 = unit_of(req.center_latitude_deg, req.center_longitude_deg);
    const double max_angle = req.radius_m / d.proj.radius_m;
    std::vector<unsigned char> in_zone(static_cast<std::size_t>(bl) * bs, 0);
    std::size_t pixel_count = 0;
    for (int l = L0; l <= L1; ++l)
        for (int s = S0; s <= S1; ++s) {
            const Surface p = surface_of(d, l, s);
            if (central_angle(p.u, u0) > max_angle) continue;
            if (l < 1 || l > d.lines - 2 || (!d.wraps_lon && (s < 1 || s > d.samples - 2)))
                return out_of_coverage("part of the zone has no full 3x3 DEM window (grid edge)");
            if (d.max_latitude_deg && p.lat_deg > *d.max_latitude_deg)
                return out_of_coverage("part of the zone is north of the product's declared MAXIMUM_LATITUDE " +
                                       fmt(*d.max_latitude_deg) + " deg");
            if (d.min_latitude_deg && p.lat_deg < *d.min_latitude_deg)
                return out_of_coverage("part of the zone is south of the product's declared MINIMUM_LATITUDE " +
                                       fmt(*d.min_latitude_deg) + " deg");
            for (int dl = -1; dl <= 1; ++dl)  // the whole Horn window must be in an installed tile
                for (int ds = -1; ds <= 1; ++ds)
                    if (!dem->covers(l + dl, s + ds))
                        return out_of_coverage("part of the zone lies in a tile that is not installed");
            in_zone[static_cast<std::size_t>(l - L0) * bs + (s - S0)] = 1;
            ++pixel_count;
        }

    // Pass 2: read the window (+1 px border for Horn) and compute slopes of zone pixels.
    const int wl = bl + 2, ws = bs + 2;
    std::vector<float> h(static_cast<std::size_t>(wl) * ws);
    dem->read_window(L0 - 1, S0 - 1, wl, ws, h.data());
    slope::Projection wp = d.proj;  // same projection, offsets relative to the window origin
    wp.line_off -= L0 - 1;
    wp.sample_off -= S0 - 1;

    std::vector<double> slopes;
    slopes.reserve(pixel_count);
    std::size_t nodata = 0, ok = 0;
    double sum = 0, worst = -1;
    int worst_l = 0, worst_s = 0;
    for (int l = L0; l <= L1; ++l)
        for (int s = S0; s <= S1; ++s) {
            if (!in_zone[static_cast<std::size_t>(l - L0) * bs + (s - S0)]) continue;
            const double sl =
                cyl ? slope::horn_slope_xy(h.data(), wl, ws, l - L0 + 1, s - S0 + 1,
                                           cyl_spacing_m(d) * std::cos((d.proj.line_off - l) / d.ppd / DEG),
                                           cyl_spacing_m(d), d.proj.radius_m)
                    : slope::horn_at(h.data(), wl, ws, l - L0 + 1, s - S0 + 1, wp, 0.0).slope_deg;
            if (!std::isfinite(sl)) {
                ++nodata;
                continue;
            }
            slopes.push_back(sl);
            sum += sl;
            ok += sl <= req.max_slope_deg;
            if (sl > worst) worst = sl, worst_l = l, worst_s = s;
        }

    const std::size_t valid = slopes.size();
    json stats = {{"pixel_count", pixel_count},
                  {"nodata_count", nodata},
                  {"fraction_ok", valid ? static_cast<double>(ok) / static_cast<double>(valid) : 0.0},
                  {"slope_max_deg", nullptr},
                  {"slope_mean_deg", nullptr},
                  {"slope_p95_deg", nullptr},
                  {"worst_pixel", nullptr}};
    if (valid) {
        const std::size_t rank = static_cast<std::size_t>(std::ceil(0.95 * static_cast<double>(valid))) - 1;
        std::nth_element(slopes.begin(), slopes.begin() + static_cast<std::ptrdiff_t>(rank), slopes.end());
        const Surface w = surface_of(d, worst_l, worst_s);
        stats["slope_max_deg"] = worst;
        stats["slope_mean_deg"] = sum / static_cast<double>(valid);
        stats["slope_p95_deg"] = slopes[rank];
        stats["worst_pixel"] = {{"latitude_deg", w.lat_deg}, {"longitude_deg", w.lon_deg}, {"slope_deg", worst}};
        if (worst > EXTREME_SLOPE_DEG && !d.synthetic)
            out["warnings"].push_back("Steepest pixel is " + fmt(worst, "%.1f") +
                                      " deg (> 50 deg): check it is not a DEM interpolation artefact.");
    }
    out["status"] = "computed";
    out["stats"] = stats;
    const double nodata_fraction = pixel_count ? static_cast<double>(nodata) / static_cast<double>(pixel_count) : 1.0;
    if (!valid || nodata_fraction > req.max_nodata_fraction)
        out["verdict"] = "insufficient_data";
    else
        out["verdict"] = stats["fraction_ok"].get<double>() >= req.required_fraction ? "pass" : "fail";
    return out;
}

std::string dem_coverage_label(const DemInfo& d) {
    const auto lat = [](double v) { return fmt(std::fabs(v)) + (v < 0 ? "S" : v > 0 ? "N" : ""); };
    std::string range;
    if (d.grid == DemGrid::polar_south)
        range = "90S-" + (d.max_latitude_deg ? lat(*d.max_latitude_deg) : std::string("?"));
    else if (d.grid == DemGrid::polar_north)
        range = (d.min_latitude_deg ? lat(*d.min_latitude_deg) : std::string("?")) + "-90N";
    else
        range = (d.min_latitude_deg ? lat(*d.min_latitude_deg) : std::string("?")) + "-" +
                (d.max_latitude_deg ? lat(*d.max_latitude_deg) : std::string("?")) + ", " + d.file;
    return d.product_id + " (" + range + ", " + fmt(d.proj.scale_m, "%.0f") + " m)";
}

json slope_check_any(const SlopeCheckRequest& req, const std::vector<const Dem*>& dems,
                     const std::string& unavailable_reason) {
    if (dems.empty()) return slope_check(req, nullptr, unavailable_reason);
    std::string tried;
    for (const Dem* dem : dems) tried += (tried.empty() ? "" : "; ") + dem_coverage_label(dem->info());
    json first;
    for (const Dem* dem : dems) {
        json r = slope_check(req, dem, unavailable_reason);
        if (r["status"] != "out_of_coverage") {
            if (dems.size() > 1)
                r["warnings"].push_back("Slope DEM used: " + dem_coverage_label(dem->info()) +
                                        ", the finest installed product covering the whole zone (installed: " + tried + ").");
            return r;
        }
        if (first.is_null()) first = std::move(r);
    }
    first["warnings"].push_back("No installed slope DEM covers the whole zone. Installed: " + tried + ".");
    return first;
}

}  // namespace selene
