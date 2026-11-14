// slope-tiles: offline per-pixel terrain slope and aspect from a LOLA polar-stereographic DEM
// (PDS LDEM_*_FLOAT.IMG + .LBL), written as uint16 LOD tiles in the same layout as
// apps/web/public/data/polar_s (apps/web/scripts/tile_polar_dem.py) so the web front can reuse its
// loader and threshold slope in a shader.
//
// Usage:
//   slope-tiles LDEM.IMG LDEM.LBL OUT_DIR [--baseline N] [--levels 7] [--tile 256]
//               [--flat-tan 1e-4] [--no-aspect] [--sign-y 1] [--sign-line -1] [--source-sha256 HEX]
//
// Output (OUT_DIR):
//   manifest.json              provenance, projection, method, conventions, statistics
//   slope/L{n}/{row}_{col}.u16 8-byte header float32 LE offset_deg (0), step_deg; then tile x tile
//   aspect/L{n}/{row}_{col}.u16 uint16 LE; deg = offset + value * step; 65535 = no data
// Tiles whose pixels are all no-data are not written (as in tile_polar_dem.py).
//
// The method and conventions are documented in slope_core.hpp and repeated in manifest.json.

#include <nlohmann/json.hpp>

#include <array>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>

#include "dem_label.hpp"
#include "slope_core.hpp"

#ifdef _OPENMP
#include <omp.h>
#endif

using json = nlohmann::ordered_json;
namespace fs = std::filesystem;
using namespace selene::slope;

namespace {

using selene::dem::Label;
using selene::dem::parse_label;

struct Args {
    fs::path img, lbl, out;
    int baseline = 1, levels = 7, tile = 256, sign_y = 1, sign_line = -1;
    double flat_tan = 1e-4;
    bool aspect = true;
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
        if (s == "--baseline") a.baseline = std::stoi(next());
        else if (s == "--levels") a.levels = std::stoi(next());
        else if (s == "--tile") a.tile = std::stoi(next());
        else if (s == "--flat-tan") a.flat_tan = std::stod(next());
        else if (s == "--no-aspect") a.aspect = false;
        else if (s == "--sign-y") a.sign_y = std::stoi(next());
        else if (s == "--sign-line") a.sign_line = std::stoi(next());
        else if (s == "--source-sha256") a.sha256 = next();
        else if (s.rfind("--", 0) == 0) throw std::runtime_error("unknown option " + s);
        else pos.push_back(s);
    }
    if (pos.size() != 3) throw std::runtime_error("usage: slope-tiles LDEM.IMG LDEM.LBL OUT_DIR [options]");
    if (a.baseline < 1 || a.levels < 1 || a.tile < 16 || std::abs(a.sign_y) != 1 || std::abs(a.sign_line) != 1)
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

// Writes one level; returns {rows, cols, tiles written}.
std::array<int, 3> write_level(const std::vector<std::uint16_t>& img, int lines, int samples, int tile, float step,
                               const fs::path& dir) {
    fs::create_directories(dir);
    const int rows = (lines + tile - 1) / tile, cols = (samples + tile - 1) / tile;
    int written = 0, failed = 0;
#pragma omp parallel for schedule(dynamic) reduction(+ : written, failed)
    for (int rc = 0; rc < rows * cols; ++rc) {
        const int r = rc / cols, c = rc % cols;
        std::vector<std::uint16_t> block(static_cast<std::size_t>(tile) * tile, NODATA);
        bool any = false;
        for (int y = 0; y < tile && r * tile + y < lines; ++y)
            for (int x = 0; x < tile && c * tile + x < samples; ++x) {
                const std::uint16_t v = img[static_cast<std::size_t>(r * tile + y) * samples + c * tile + x];
                block[static_cast<std::size_t>(y) * tile + x] = v;
                any |= v != NODATA;
            }
        if (!any) continue;
        const float header[2] = {0.0f, step};  // little-endian host checked in main
        std::ofstream f(dir / (std::to_string(r) + "_" + std::to_string(c) + ".u16"), std::ios::binary);
        f.write(reinterpret_cast<const char*>(header), sizeof header);
        f.write(reinterpret_cast<const char*>(block.data()), static_cast<std::streamsize>(block.size() * 2));
        if (!f) ++failed;  // no exceptions out of an OpenMP region
        else ++written;
    }
    if (failed) throw std::runtime_error(std::to_string(failed) + " tile writes failed in " + dir.string());
    return {rows, cols, written};
}

json slope_stats(const std::vector<std::uint16_t>& q) {
    std::vector<std::uint64_t> hist(65536, 0);
    for (std::uint16_t v : q) ++hist[v];
    const std::uint64_t valid = q.size() - hist[NODATA];
    json s{{"pixels", q.size()}, {"nodata_pixels", hist[NODATA]},
           {"nodata_percent", 100.0 * static_cast<double>(hist[NODATA]) / static_cast<double>(q.size())}};
    if (!valid) return s;
    auto pct = [&](double p) {
        const std::uint64_t target = static_cast<std::uint64_t>(p / 100.0 * static_cast<double>(valid - 1));
        std::uint64_t acc = 0;
        for (int v = 0; v < 65535; ++v) {
            acc += hist[v];
            if (acc > target) return v * SLOPE_STEP_DEG;
        }
        return 65534 * SLOPE_STEP_DEG;
    };
    auto above = [&](double deg) {
        std::uint64_t n = 0;
        for (int v = 0; v < 65535; ++v)
            if (v * SLOPE_STEP_DEG > deg) n += hist[v];
        return 100.0 * static_cast<double>(n) / static_cast<double>(valid);
    };
    s["min_deg"] = pct(0);
    s["p01_deg"] = pct(1);
    s["median_deg"] = pct(50);
    s["p90_deg"] = pct(90);
    s["p99_deg"] = pct(99);
    s["p99_9_deg"] = pct(99.9);
    s["max_deg"] = pct(100);
    s["percent_above"] = {{"5", above(5)}, {"10", above(10)}, {"15", above(15)}, {"20", above(20)},
                          {"30", above(30)}, {"40", above(40)}, {"50", above(50)}};
    return s;
}

std::string utc_now() {
    const std::time_t t = std::time(nullptr);
    char buf[32];
    std::strftime(buf, sizeof buf, "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&t));
    return buf;
}

}  // namespace

int main(int argc, char** argv) try {
    const std::uint16_t one = 1;
    if (*reinterpret_cast<const unsigned char*>(&one) != 1) throw std::runtime_error("big-endian host unsupported");
    const Args a = parse_args(argc, argv);
    const Label lab = parse_label(a.lbl);
    const double t0 = now_s();

    const std::size_t n = static_cast<std::size_t>(lab.lines) * lab.samples;
    if (fs::file_size(a.img) != n * 4) throw std::runtime_error("image size does not match label");
    std::vector<float> dem(n);
    {
        std::ifstream f(a.img, std::ios::binary);
        f.read(reinterpret_cast<char*>(dem.data()), static_cast<std::streamsize>(n * 4));
        if (!f) throw std::runtime_error("read failed: " + a.img.string());
    }
    // Heights in km (HEIGHT = DN * SCALING_FACTOR; radius = HEIGHT + OFFSET). Implausible values
    // (|h| > 100 km, far outside the label's DERIVED range) are treated as no-data.
    std::size_t src_nodata = 0;
    for (float& v : dem) {
        v = static_cast<float>(v * lab.scaling);
        if (!std::isfinite(v) || std::fabs(v) > 100.0f) {
            v = std::numeric_limits<float>::quiet_NaN();
            ++src_nodata;
        }
    }
    const double t_read = now_s();
    std::printf("read %s: %dx%d px, %g m/px, %zu no-data source px (%.1f s)\n", a.img.filename().c_str(), lab.lines,
                lab.samples, lab.scale_m, src_nodata, t_read - t0);

    Projection p;
    p.radius_m = lab.radius_km * 1000.0;
    p.sign_y = a.sign_y;
    p.sign_line = a.sign_line;
    int lines = lab.lines, samples = lab.samples;
    const int b = a.baseline;
    // Level-0 pixel i of a b-coarsened grid covers source pixels b*i .. b*i+b-1: source coordinate
    // u maps to (u + 0.5) / b - 0.5.
    p.line_off = (lab.line_off + 0.5) / b - 0.5;
    p.sample_off = (lab.sample_off + 0.5) / b - 0.5;
    p.scale_m = lab.scale_m * b;
    if (b > 1) {
        int ol, os;
        dem = block_mean(dem.data(), lines, samples, b, ol, os);
        lines = ol;
        samples = os;
        std::printf("baseline x%d: block mean -> %dx%d px at %g m\n", b, lines, samples, p.scale_m);
    }

    std::vector<std::uint16_t> slope(static_cast<std::size_t>(lines) * samples), aspect;
    if (a.aspect) aspect.resize(slope.size());
    slope_aspect_grid(dem.data(), lines, samples, p, a.flat_tan, slope.data(), a.aspect ? aspect.data() : nullptr);
    std::vector<float>().swap(dem);  // free the DEM before the pyramid
    const double t_grad = now_s();
    std::printf("Horn slope/aspect: %.1f s\n", t_grad - t_read);

    const json stats_l0 = slope_stats(slope);
    std::size_t aspect_nodata = 0;
    for (std::uint16_t v : aspect) aspect_nodata += v == NODATA;

    json levels_slope = json::array(), levels_aspect = json::array();
    for (int lv = 0; lv < a.levels; ++lv) {
        if (lv) {
            std::vector<std::uint16_t> s2, a2;
            int ol, os;
            max_pool(slope.data(), a.aspect ? aspect.data() : nullptr, lines, samples, s2, a2, ol, os);
            slope.swap(s2);
            aspect.swap(a2);
            lines = ol;
            samples = os;
        }
        const double sc = p.scale_m * (1 << lv);
        auto ls = write_level(slope, lines, samples, a.tile, static_cast<float>(SLOPE_STEP_DEG),
                              a.out / "slope" / ("L" + std::to_string(lv)));
        levels_slope.push_back({{"level", lv}, {"scale_m", sc}, {"lines", lines}, {"samples", samples},
                                {"rows", ls[0]}, {"cols", ls[1]}, {"tiles", ls[2]}});
        if (a.aspect) {
            auto la = write_level(aspect, lines, samples, a.tile, static_cast<float>(ASPECT_STEP_DEG),
                                  a.out / "aspect" / ("L" + std::to_string(lv)));
            levels_aspect.push_back({{"level", lv}, {"scale_m", sc}, {"lines", lines}, {"samples", samples},
                                     {"rows", la[0]}, {"cols", la[1]}, {"tiles", la[2]}});
        }
        std::printf("  L%d: %dx%d px at %g m -> %d slope tiles\n", lv, samples, lines, sc, ls[2]);
    }
    const double t_end = now_s();

    std::string cmd;
    for (int i = 0; i < argc; ++i) cmd += (i ? " " : "") + fs::path(argv[i]).filename().string();

    const double baseline_m = lab.scale_m * b;
    json m;
    m["product"] = "terrain slope and aspect (derived)";
    m["status"] = "derived from NASA LOLA DEM; not validated against independent slope products";
    m["generator"] = {{"tool", "services/science/tools/slope_tiles.cpp"},
                      {"command", cmd},
                      {"created_utc", utc_now()},
                      {"wall_time_s", t_end - t0}};
    m["source"] = {
        {"file", a.img.filename().string()},
        {"label", a.lbl.filename().string()},
        {"product_id", lab.product_id},
        {"sha256", a.sha256.empty() ? json(nullptr) : json(a.sha256)},
        {"sha256_note", a.sha256.empty() ? "not supplied" : "supplied by caller (--source-sha256), not recomputed by the tool"},
        {"description", "LOLA gridded polar DEM, LRO-L-LOLA-4-GDR-V1.0, heights in km relative to a 1737.4 km sphere"},
        {"producer", "LRO LOLA team, NASA GSFC; PDS Geosciences Node"},
        {"url", "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/"},
        {"license", "NASA PDS data, public; credit NASA/GSFC LOLA team"},
        {"time_coverage", lab.start_time + "/" + lab.stop_time + " (label START_TIME/STOP_TIME)"},
        {"source_nodata_pixels", src_nodata}};
    m["frame"] = lab.frame;
    m["vertical_reference"] = "sphere of radius " + std::to_string(lab.radius_km) +
                              " km (label OFFSET); slope is relative to the radial direction (sphere normal), "
                              "not the local gravity / geoid normal";
    m["projection"] = {
        {"type", "polar_stereographic_sphere"},
        {"center_lat", lab.center_lat},
        {"center_lon", lab.center_lon},
        {"radius_m", p.radius_m},
        {"line_off", p.line_off},
        {"sample_off", p.sample_off},
        {"scale_m", p.scale_m},
        {"scale_true_at", "pole (label: 'true at the pole in polar stereographic (spherical) projection')"},
        {"sign_y", p.sign_y},
        {"sign_line", p.sign_line},
        {"signs_origin", (p.sign_y == 1 && p.sign_line == -1)
                             ? "same as apps/web/public/data/polar_s/manifest.json, validated by tile_polar_dem.py "
                               "against ldem_16 (wrong signs give km-level errors)"
                             : "set on the command line; NOT the validated polar_s signs"},
        {"pixel_index", "0-based pixel centres at level 0; level n: (index + 0.5) / 2^n - 0.5"},
        {"map_coords", "x = (sample - sample_off) * scale_m, y = sign_line * (line - line_off) * scale_m, "
                       "lon - center_lon = atan2(x, sign_y * y)"}};
    m["method"] = {
        {"grid", "native polar stereographic grid, no lat/lon resampling"},
        {"gradient", "Horn (1981) 3x3 weighted finite differences on heights in metres"},
        {"baseline_m", baseline_m},
        {"baseline_factor", b},
        {"baseline_note", b == 1 ? "native 20 m pixels; Horn window spans 3 px = " + std::to_string(3 * baseline_m) + " m"
                                 : "DEM block-averaged " + std::to_string(b) + "x" + std::to_string(b) +
                                       " before the gradient (any no-data child -> no-data)"},
        {"pixel_spacing", "ground spacing = scale_m / k * (R + h) / R, k = 2 / (1 + cos(colatitude)) = 1 + "
                          "(rho / 2R)^2 (sphere, true at the pole, conformal so isotropic), h = centre height; "
                          "k = 1.0019 at 85 S; (R + h) / R within +-0.4 %"},
        {"slope", "slope_deg = atan(|grad z|)"},
        {"aspect", "azimuth of steepest descent (-grad z) in GRID coordinates: degrees in [0, 360), clockwise "
                   "from image-up (decreasing line) toward image-right (increasing sample)"},
        {"aspect_to_geographic",
         "geographic azimuth (clockwise from local north) = project the grid direction onto the image-space "
         "north (sin dlon, -sign_line*sign_y*cos dlon) and east (cos dlon, sign_line*sign_y*sin dlon) vectors "
         "(right, up), dlon = lon - center_lon; for sign_y = 1, sign_line = -1: az_geo = (az_grid - lon_east) "
         "mod 360. See geographic_azimuth_deg() in services/science/src/slope_core.hpp"},
        {"pole_policy", "geographic azimuth is undefined at rho = 0; fallback dlon = 0 (grid-up = toward the "
                        "center_lon meridian, body-fixed +X). No LDEM_85S_20M pixel centre lies exactly on the "
                        "pole (offset 7583.5 = pixel corner); geographic aspect is ill-conditioned within a few "
                        "pixels of the pole, grid aspect is not"},
        {"flat_threshold", {{"tan", a.flat_tan}, {"deg", std::atan(a.flat_tan) * DEG},
                            {"policy", "|grad| below threshold -> aspect no-data (slope still reported)"}}},
        {"nodata_policy", "any non-finite source height in the 3x3 window, or a grid-border pixel, -> no-data "
                          "(65535); never zero"},
        {"pyramid", "x2 coarser per level (floor). slope: MAX of the 2x2 children (conservative for hazard "
                    "display: a coarse pixel is at least as steep as its steepest child); any no-data child -> "
                    "no-data. aspect: aspect of the child with the max slope (first in raster order on ties). "
                    "Coarse levels are therefore NOT slopes at a coarser baseline"}};
    m["scale_warning"] =
        "Slope at a " + std::to_string(static_cast<int>(baseline_m)) +
        " m baseline (3x3 Horn window ~" + std::to_string(static_cast<int>(3 * baseline_m)) +
        " m) is NOT lander-footprint (meter-scale) slope: boulders, small craters and roughness below the DEM "
        "resolution are not resolved and local slopes at lander scale are generally steeper. LDEM_85S_20M is "
        "itself interpolated (GMT 'surface') between LOLA tracks, so slopes in poorly sampled areas are smoothed. "
        "Use for site screening/visualisation only, not landing certification.";
    m["warnings"] = json::array(
        {m["scale_warning"],
         "Grid aspect is not a geographic azimuth; convert with method.aspect_to_geographic (depends on longitude).",
         "Isolated extreme slopes (> 50 deg) can be DEM interpolation artefacts between LOLA tracks (sparser "
         "away from the pole); inspect before treating them as real cliffs.",
         "Slope uses the sphere normal as vertical; the deflection of the vertical (geoid) is ignored."});
    m["tile"] = a.tile;
    m["encoding"] = "8-byte header float32 LE offset_deg, step_deg; then uint16 LE; deg = offset + value * step; "
                    "65535 = no data";
    m["units"] = "degrees";
    m["levels"] = levels_slope;  // same grid for both layers; top-level for polar_s loader compatibility
    m["layers"] = json::object();
    m["layers"]["slope"] = {{"path", "slope/L{level}/{row}_{col}.u16"},
                            {"offset_deg", 0.0},
                            {"step_deg", static_cast<float>(SLOPE_STEP_DEG)},
                            {"quantization_error_deg", SLOPE_STEP_DEG / 2},
                            {"range_deg", {0.0, 90.0}},
                            {"levels", levels_slope}};
    if (a.aspect)
        m["layers"]["aspect"] = {{"path", "aspect/L{level}/{row}_{col}.u16"},
                                 {"offset_deg", 0.0},
                                 {"step_deg", static_cast<float>(ASPECT_STEP_DEG)},
                                 {"quantization_error_deg", ASPECT_STEP_DEG / 2},
                                 {"range_deg", {0.0, 360.0}},
                                 {"convention", "grid aspect, see method.aspect"},
                                 {"levels", levels_aspect}};
    m["statistics_level0"] = {{"slope", stats_l0},
                              {"aspect_nodata_pixels", a.aspect ? json(aspect_nodata) : json(nullptr)}};
    fs::create_directories(a.out);
    std::ofstream(a.out / "manifest.json") << m.dump(1) << "\n";
    std::cout << "statistics L0: " << stats_l0.dump() << "\n";
    std::printf("total %.1f s (read %.1f, gradient %.1f, pyramid+write %.1f); manifest -> %s\n", t_end - t0,
                t_read - t0, t_grad - t_read, t_end - t_grad, (a.out / "manifest.json").c_str());
    return 0;
} catch (const std::exception& e) {
    std::fprintf(stderr, "slope-tiles: %s\n", e.what());
    return 1;
}
