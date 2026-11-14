// PDS3 label (.LBL) parser for LOLA gridded polar DEMs (LDEM_*_FLOAT.IMG). Header-only so the offline
// tiler (tools/slope_tiles.cpp) and the service (terrain.cpp) accept exactly the same products.
//
// Only south-polar stereographic products on a sphere, PC_REAL float32 heights in km and no map
// rotation are accepted; anything else throws (we never guess a projection).
#pragma once

#include <filesystem>
#include <fstream>
#include <optional>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>

namespace selene::dem {

struct Label {
    int lines = 0, samples = 0, record_bytes = 0;
    double scale_m = 0, line_off = 0, sample_off = 0, radius_km = 0, center_lat = 0, center_lon = 0;
    double offset_km = 0, scaling = 0;
    std::string sample_type, unit, frame, projection, product_id, start_time, stop_time;
    std::string data_set_id, product_version_id;  // empty when absent from the label
    // Provenance keywords copied verbatim from the label (empty when absent; never filled in).
    std::string producer_id, producer_full_name, producer_institution_name, product_creation_time;
    std::string instrument_host_name, instrument_id;
    std::optional<double> maximum_latitude;        // MAXIMUM_LATITUDE (deg), declared coverage edge
};

inline bool label_find(const std::string& text, const std::string& key, std::string& out) {
    const std::regex re("(^|\\n)[ \\t]*" + key + "[ \\t]*=[ \\t]*\"?([^\"\\n<]*)");
    std::smatch m;
    if (!std::regex_search(text, m, re)) return false;
    out = m[2].str();
    while (!out.empty() && (out.back() == ' ' || out.back() == '\r' || out.back() == '\t')) out.pop_back();
    return true;
}

inline std::string label_value(const std::string& text, const std::string& key) {
    std::string v;
    if (!label_find(text, key, v)) throw std::runtime_error("label: " + key + " not found");
    return v;
}

inline Label parse_label_text(const std::string& t) {
    auto num = [&](const char* k) { return std::stod(label_value(t, k)); };
    Label lab;
    lab.lines = static_cast<int>(num("LINES"));
    lab.samples = static_cast<int>(num("LINE_SAMPLES"));
    lab.record_bytes = static_cast<int>(num("RECORD_BYTES"));
    lab.scale_m = num("MAP_SCALE");
    lab.line_off = num("LINE_PROJECTION_OFFSET");
    lab.sample_off = num("SAMPLE_PROJECTION_OFFSET");
    lab.radius_km = num("A_AXIS_RADIUS");
    lab.center_lat = num("CENTER_LATITUDE");
    lab.center_lon = num("CENTER_LONGITUDE");
    lab.offset_km = num("OFFSET");
    lab.scaling = num("SCALING_FACTOR");
    lab.sample_type = label_value(t, "SAMPLE_TYPE");
    lab.unit = label_value(t, "UNIT");
    lab.frame = label_value(t, "COORDINATE_SYSTEM_NAME");
    lab.projection = label_value(t, "MAP_PROJECTION_TYPE");
    lab.product_id = label_value(t, "PRODUCT_ID");
    label_find(t, "START_TIME", lab.start_time);
    label_find(t, "STOP_TIME", lab.stop_time);
    label_find(t, "DATA_SET_ID", lab.data_set_id);
    label_find(t, "PRODUCT_VERSION_ID", lab.product_version_id);
    label_find(t, "PRODUCER_ID", lab.producer_id);
    label_find(t, "PRODUCER_FULL_NAME", lab.producer_full_name);
    label_find(t, "PRODUCER_INSTITUTION_NAME", lab.producer_institution_name);
    label_find(t, "PRODUCT_CREATION_TIME", lab.product_creation_time);
    label_find(t, "INSTRUMENT_HOST_NAME", lab.instrument_host_name);
    label_find(t, "INSTRUMENT_ID", lab.instrument_id);
    std::string max_lat;
    if (label_find(t, "MAXIMUM_LATITUDE", max_lat)) lab.maximum_latitude = std::stod(max_lat);
    const bool sphere = num("A_AXIS_RADIUS") == num("B_AXIS_RADIUS") && num("A_AXIS_RADIUS") == num("C_AXIS_RADIUS");
    if (lab.sample_type != "PC_REAL" || lab.unit != "KILOMETER" || lab.projection != "POLAR STEREOGRAPHIC" ||
        !sphere || lab.center_lat != -90.0 || lab.record_bytes != lab.samples * 4 || lab.lines < 3 ||
        lab.samples < 3 || !(lab.scale_m > 0) || num("MAP_PROJECTION_ROTATION") != 0.0)
        throw std::runtime_error(
            "unsupported product (need south polar stereographic sphere, PC_REAL float32 km, no rotation)");
    return lab;
}

// True only when the label itself identifies an LRO LOLA gridded data record (e.g. DATA_SET_ID
// "LRO-L-LOLA-4-GDR-V1.0" for LDEM_85S_20M). Only then may callers attach the LOLA-specific
// archive URL, licence and GMT-interpolation caveat; any other product gets label fields only.
inline bool is_lola_gdr(const Label& lab) {
    return lab.data_set_id.rfind("LRO-L-LOLA", 0) == 0 && lab.data_set_id.find("GDR") != std::string::npos;
}

inline Label parse_label(const std::filesystem::path& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open " + path.string());
    std::stringstream ss;
    ss << f.rdbuf();
    return parse_label_text(ss.str());
}

}  // namespace selene::dem
