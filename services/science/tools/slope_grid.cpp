// slope-grid: offline slope screening of a whole LOLA polar DEM (PDS LDEM_*_FLOAT.IMG + .LBL) on
// regular grids of fixed-size discs (default 4 km diameter), for the web "South-pole grid" page.
//
// Usage:
//   slope-grid LDEM.IMG LDEM.LBL OUT.json [--diameter-m 4000] [--grids 2] [--bin-deg 0.5]
//              [--max-deg 60] [--source-sha256 HEX]
//
// Per pixel: the same Horn 3x3 slope as slope-tiles / the service check (slope_core.hpp, 20 m
// native baseline, not quantised). Per disc: slope histogram (bin-deg bins, last bin open-ended),
// valid / no-data pixel counts, mean and max. Disc layout and coverage rules: slope_grid.hpp.
// Output: one JSON with provenance, method, conventions and per-disc columns (see "columns").

#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>

#include "dem_label.hpp"
#include "slope_core.hpp"
#include "slope_grid.hpp"

using json = nlohmann::ordered_json;
namespace fs = std::filesystem;
using namespace selene::slope;

namespace {

struct Args {
    fs::path img, lbl, out;
    double diameter_m = 4000, bin_deg = 0.5, max_deg = 60;
    int grids = 2;
    std::string sha256;
};

Args parse_args(int argc, char** argv) {
    Args a;
    std::vector<std::string> pos;
    for (int i = 1; i < argc; ++i) {
        std::string s = argv[i];
        auto next = [&]() -> std::string {
            if (i + 1 >= argc) throw std::runtime_error("missing value for " + s);
            return argv[++i];
        };
        if (s == "--diameter-m") a.diameter_m = std::stod(next());
        else if (s == "--grids") a.grids = std::stoi(next());
        else if (s == "--bin-deg") a.bin_deg = std::stod(next());
        else if (s == "--max-deg") a.max_deg = std::stod(next());
        else if (s == "--source-sha256") a.sha256 = next();
        else if (s.rfind("--", 0) == 0) throw std::runtime_error("unknown option " + s);
        else pos.push_back(s);
    }
    if (pos.size() != 3) throw std::runtime_error("usage: slope-grid LDEM.IMG LDEM.LBL OUT.json [options]");
    if (!(a.diameter_m > 0) || a.grids < 1 || a.grids > 4 || !(a.bin_deg > 0) || !(a.max_deg > a.bin_deg))
        throw std::runtime_error("invalid option value");
    a.img = pos[0];
    a.lbl = pos[1];
    a.out = pos[2];
    return a;
}

double now_s() {
    using namespace std::chrono;
    return duration<double>(steady_clock::now().time_since_epoch()).count();
}

std::string utc_now() {
    const std::time_t t = std::time(nullptr);
    char buf[32];
    std::strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&t));
    return buf;
}

// Rounds to `decimals` places as the double nearest the decimal value (prints without float noise).
double round_to(double v, int decimals) {
    const double f = std::pow(10.0, decimals);
    return std::round(v * f) / f;
}

}  // namespace

int main(int argc, char** argv) try {
    const std::uint16_t one = 1;
    if (*reinterpret_cast<const unsigned char*>(&one) != 1) throw std::runtime_error("big-endian host unsupported");
    const Args a = parse_args(argc, argv);
    const auto lab = selene::dem::parse_label(a.lbl);
    const double t0 = now_s();

    const int L = lab.lines, S = lab.samples;
    const std::size_t n = static_cast<std::size_t>(L) * S;
    if (fs::file_size(a.img) != n * 4) throw std::runtime_error("image size does not match label");
    std::vector<float> dem(n);
    {
        std::ifstream f(a.img, std::ios::binary);
        f.read(reinterpret_cast<char*>(dem.data()), static_cast<std::streamsize>(n * 4));
        if (!f) throw std::runtime_error("read failed: " + a.img.string());
    }
    for (float& v : dem) {  // km; implausible values -> no-data (same rule as slope-tiles)
        v = static_cast<float>(v * lab.scaling);
        if (!std::isfinite(v) || std::fabs(v) > 100.0f) v = std::numeric_limits<float>::quiet_NaN();
    }

    Projection p;  // validated LDEM_85S_20M signs (same as slope-tiles defaults)
    p.radius_m = lab.radius_km * 1000.0;
    p.line_off = lab.line_off;
    p.sample_off = lab.sample_off;
    p.scale_m = lab.scale_m;
    p.sign_y = 1;
    p.sign_line = -1;

    std::vector<float> slope(n);
#pragma omp parallel for schedule(dynamic, 16)
    for (int l = 0; l < L; ++l)
        for (int s = 0; s < S; ++s)
            slope[static_cast<std::size_t>(l) * S + s] = static_cast<float>(horn_at(dem.data(), L, S, l, s, p, 1e-4).slope_deg);
    std::vector<float>().swap(dem);
    const double t_slope = now_s();
    std::printf("Horn slope %dx%d px: %.1f s\n", S, L, t_slope - t0);

    // Coverage: declared MAXIMUM_LATITUDE (edge of the south-polar product), else the inscribed circle of the grid.
    const double grid_rho = std::min({p.sample_off, S - 1 - p.sample_off, p.line_off, L - 1 - p.line_off}) * p.scale_m;
    double rho_max = grid_rho;
    std::string coverage_src = "inscribed circle of the pixel grid";
    if (lab.maximum_latitude) {
        rho_max = std::min(grid_rho, rho_of_colat((90.0 + *lab.maximum_latitude) / DEG, p.radius_m));
        coverage_src = "label MAXIMUM_LATITUDE " + std::to_string(*lab.maximum_latitude) + " (bounded by the grid)";
    }

    const double radius = a.diameter_m / 2, step = a.diameter_m;
    std::vector<DiscCentre> centres;
    json grids = json::array();
    for (int g = 0; g < a.grids; ++g) {
        auto c = grid_centres(g, step, radius, rho_max, p.radius_m);
        grids.push_back({{"id", g}, {"offset_steps", {GRID_OFFSETS[g][0], GRID_OFFSETS[g][1]}}, {"discs", c.size()}});
        centres.insert(centres.end(), c.begin(), c.end());
    }
    const int bins = static_cast<int>(std::ceil(a.max_deg / a.bin_deg)) + 1;  // + open-ended last bin
    std::vector<DiscStats> stats(centres.size());
#pragma omp parallel for schedule(dynamic, 8)
    for (long i = 0; i < static_cast<long>(centres.size()); ++i)
        stats[i] = disc_stats(slope.data(), L, S, p, centres[i], radius, a.bin_deg, bins);
    const double t_end = now_s();
    std::printf("%zu discs (%d grids, diameter %g m): %.1f s\n", centres.size(), a.grids, a.diameter_m, t_end - t_slope);

    json col_g = json::array(), col_x = json::array(), col_y = json::array(), col_lat = json::array(),
         col_lon = json::array(), col_valid = json::array(), col_nodata = json::array(), col_mean = json::array(),
         col_max = json::array(), col_hist = json::array();
    for (std::size_t i = 0; i < centres.size(); ++i) {
        const auto& c = centres[i];
        const auto& s = stats[i];
        const LatLon ll = south_polar_latlon(p, lab.center_lon, c.x_m, c.y_m);
        col_g.push_back(c.grid);
        col_x.push_back(round_to(c.x_m / 1000, 3));
        col_y.push_back(round_to(c.y_m / 1000, 3));
        col_lat.push_back(round_to(ll.lat_deg, 5));
        col_lon.push_back(round_to(ll.lon_deg, 5));
        col_valid.push_back(s.valid);
        col_nodata.push_back(s.nodata);
        col_mean.push_back(s.valid ? json(round_to(s.mean_deg, 3)) : json(nullptr));
        col_max.push_back(s.valid ? json(round_to(s.max_deg, 3)) : json(nullptr));
        std::size_t last = s.hist.size();
        while (last > 0 && s.hist[last - 1] == 0) --last;
        col_hist.push_back(std::vector<std::uint32_t>(s.hist.begin(), s.hist.begin() + static_cast<long>(last)));
    }

    std::string cmd;
    for (int i = 0; i < argc; ++i) cmd += (i ? " " : "") + fs::path(argv[i]).filename().string();
    json m;
    m["product"] = "slope screening on disc grids (derived)";
    m["status"] = "derived from NASA LOLA DEM; not validated against independent slope products; screening only";
    m["generator"] = {{"tool", "services/science/tools/slope_grid.cpp"}, {"command", cmd}, {"created_utc", utc_now()},
                      {"wall_time_s", t_end - t0}};
    m["source"] = {{"file", a.img.filename().string()},
                   {"product_id", lab.product_id},
                   {"sha256", a.sha256.empty() ? json(nullptr) : json(a.sha256)},
                   {"sha256_note", a.sha256.empty() ? "not supplied" : "supplied by caller, not recomputed"},
                   {"producer", "LRO LOLA team, NASA GSFC; PDS Geosciences Node"},
                   {"license", "NASA PDS data, public; credit NASA/GSFC LOLA team"},
                   {"time_coverage", lab.start_time + "/" + lab.stop_time + " (label START_TIME/STOP_TIME)"}};
    m["frame"] = lab.frame;
    m["coordinates"] = "lat planetocentric, lon east-positive [-180, 180), degrees; x_km/y_km = polar stereographic map "
                       "coordinates (x = image-right, y = sign_line * (line - line_off) * scale = image-up for sign_line -1), "
                       "lon = center_lon + atan2(x, y); centre at the exact pole: lon = center_lon (deterministic)";
    m["projection"] = {{"center_lat", lab.center_lat}, {"center_lon", lab.center_lon}, {"radius_m", p.radius_m},
                       {"scale_m", p.scale_m}, {"sign_y", p.sign_y}, {"sign_line", p.sign_line}};
    m["method"] = {
        {"slope", "Horn (1981) 3x3 on the native " + std::to_string(static_cast<int>(p.scale_m)) +
                      " m grid, slope_core.hpp (same as slope-tiles L0 and the service check), unquantised"},
        {"disc_diameter_m", a.diameter_m},
        {"disc_radius", "ground distance on the reference sphere; map radius = radius * k(rho), k = 1 + (rho/2R)^2; "
                        "terrain height ignored for membership (<= 0.4 %)"},
        {"step_m", step},
        {"step_note", "map distance between centres of one grid (ground spacing = step / k, >= 99.8 % of step here)"},
        {"grids", grids},
        {"grid_offsets", "grid g centres at ((i + ox) * step, (j + oy) * step); grids 0 + 1 together cover the plane "
                         "(square lattice of pitch step / sqrt 2, covering radius step / 2)"},
        {"pixel_membership", "pixel centre within the disc's map radius"},
        {"coverage", {{"rho_max_m", rho_max}, {"source", coverage_src},
                      {"rule", "only discs entirely inside the coverage circle"}}},
        {"histogram", {{"bin_deg", a.bin_deg}, {"bins", bins},
                       {"rule", "bin b = [b * bin_deg, (b + 1) * bin_deg); last bin open-ended; trailing zero bins "
                                "omitted; counts of valid 20 m pixels"}}}};
    m["scale_warning"] = "Slope at the DEM's 20 m pixel (3x3 Horn window ~60 m) is NOT lander-footprint slope: "
                         "boulders and metre-scale roughness are not resolved. Screening only, not landing certification.";
    m["columns"] = {{"grid", col_g}, {"x_km", col_x}, {"y_km", col_y}, {"lat", col_lat}, {"lon", col_lon},
                    {"valid_px", col_valid}, {"nodata_px", col_nodata}, {"mean_deg", col_mean},
                    {"max_deg", col_max}, {"hist", col_hist}};
    if (a.out.has_parent_path()) fs::create_directories(a.out.parent_path());
    std::ofstream(a.out) << m.dump() << "\n";
    std::printf("total %.1f s -> %s\n", t_end - t0, a.out.c_str());
    return 0;
} catch (const std::exception& e) {
    std::fprintf(stderr, "slope-grid: %s\n", e.what());
    return 1;
}
