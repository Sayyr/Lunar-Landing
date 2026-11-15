// Server-side terrain slope check of a circular zone on the full-resolution DEM
// (POST /terrain/slope/check, contract: packages/contracts/schemas/slope-check-*.schema.json).
//
// Slope maths is NOT re-implemented here: per-pixel slope is selene::slope::horn_at()
// (slope_core.hpp), the same Horn 3x3 + polar-stereographic spacing correction used for the
// pre-computed web tiles. This file only selects the zone's pixels, reads the DEM window around
// it and aggregates the verdict.
//
// Conventions (also returned in the response `assumptions`):
//  * Input latitude planetocentric, longitude east-positive, both in the DEM's body-fixed frame
//    (label COORDINATE_SYSTEM_NAME, "MEAN EARTH/POLAR AXIS OF DE421" for LDEM_85S_20M). No frame
//    conversion is applied.
//  * Zone membership: a DEM pixel belongs to the zone iff the great-circle distance, on the
//    label's reference sphere (1737.4 km), between its centre (exact inverse polar stereographic)
//    and the zone centre is <= radius_m. Terrain height is ignored for selection.
//  * Coverage: every zone pixel must have a full 3x3 Horn window inside the grid and lie inside the
//    label's declared latitude range (and in an installed tile for the SLDEM2015 mosaic), else
//    status = out_of_coverage (never a partial verdict).
//  * Grids: polar stereographic on either pole (LOLA LDEM_*S_* / LDEM_*N_*) with the isotropic
//    spacing correction of slope_core.hpp, or simple cylindrical (SLDEM2015, 60S-60N) with east-west
//    spacing R cos(lat) dlon and north-south spacing R dlat (slope::horn_slope_xy).
//  * No-data: non-finite heights or |h| > 100 km (as slope-tiles), or any no-data in the 3x3
//    window -> pixel without slope; counted in nodata_count, never treated as flat.
#pragma once

#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "models.hpp"
#include "slope_core.hpp"

namespace selene {

// Map grid of a DEM. Polar products: spherical polar stereographic on either pole (proj below).
// Cylindrical (SLDEM2015): simple cylindrical, 0-based line = proj.line_off - lat * ppd and
// sample = proj.sample_off + lon * ppd with lon in [0, 360); wraps_lon = the grid spans 360 deg.
enum class DemGrid { polar_south, polar_north, cylindrical };

struct DemInfo {
    DemGrid grid = DemGrid::polar_south;
    double ppd = 0;              // cylindrical: pixels per degree (label MAP_RESOLUTION)
    bool wraps_lon = false;      // cylindrical: samples cover 360 deg, sample index wraps
    slope::Projection proj;      // pixel grid <-> polar stereographic map (line/sample offsets 0-based)
    int lines = 0, samples = 0;
    double center_lon_deg = 0;   // projection central meridian (label CENTER_LONGITUDE)
    // Declared coverage edge (label MAXIMUM_LATITUDE, -85 for LDEM_85S_20M). The square grid's
    // corners hold values beyond it, but the product is only declared valid south of this latitude.
    std::optional<double> max_latitude_deg;
    // Declared southern edge (label MINIMUM_LATITUDE): north polar and cylindrical products.
    std::optional<double> min_latitude_deg;
    std::string product_id;      // e.g. LDEM_85S_20M; "SYNTHETIC ..." for test grids
    // Label keywords copied verbatim (empty = absent from the label, emitted as null).
    std::string product_version, data_set_id, frame, file, time_coverage;
    std::string producer_id, producer_full_name, producer_institution_name, product_creation_time;
    std::string instrument_host_name, instrument_id;
    // The label identifies an LRO LOLA GDR product (dem::is_lola_gdr): only then are the LOLA
    // archive URL, licence and GMT-interpolation caveat emitted.
    bool lola_gdr = false;
    std::optional<std::string> sha256;
    std::string sha256_note;
    // Cache key component: changes whenever the served DEM may differ (sha256 if recorded, plus
    // product id, file size and mtime for files; product id for in-memory test grids).
    std::string identity;
    bool synthetic = false;
};

class Dem {
public:
    virtual ~Dem() = default;
    const DemInfo& info() const { return info_; }
    // Heights in km of lines [l0, l0 + nl) x samples [s0, s0 + ns), row-major into out.
    // Pixels outside the grid, non-finite or implausible (|h| > 100 km) come back as NaN.
    virtual void read_window(int l0, int s0, int nl, int ns, float* out) const = 0;
    // False where the product has no data file at all (a tile of a mosaic that is not installed).
    virtual bool covers(int /*line*/, int /*sample*/) const { return true; }

    // PDS LOLA polar DEM (.IMG + .LBL). Validates the label and the file size, reads SHA256SUMS
    // next to the image if present (the hash is recorded, NOT recomputed). Nothing is loaded into
    // memory: each read_window() reads only the requested rows. Throws std::runtime_error.
    static std::shared_ptr<const Dem> open_pds(const std::filesystem::path& img,
                                               const std::filesystem::path& lbl);
    // Locates the label next to `img` (same stem, .lbl or .LBL) unless `lbl` is given.
    static std::shared_ptr<const Dem> open_pds_auto(const std::filesystem::path& img,
                                                    const std::optional<std::filesystem::path>& lbl);
    // SLDEM2015 mosaic: every sldem2015_*_float.img (+ .lbl) tile in `dir`, assembled into one
    // global simple cylindrical grid (same resolution required). Tiles missing from the directory are
    // reported by covers(); nothing is filled in. Throws std::runtime_error (no tile, bad label...).
    static std::shared_ptr<const Dem> open_sldem_dir(const std::filesystem::path& dir);
    // In-memory grid (tests and fixtures only), heights in km, NaN = no-data.
    static std::shared_ptr<const Dem> in_memory(DemInfo info, std::vector<float> heights_km);

protected:
    explicit Dem(DemInfo info) : info_(std::move(info)) {}
    DemInfo info_;
};

struct SlopeCheckRequest {
    double center_latitude_deg = 0, center_longitude_deg = 0, radius_m = 0;
    double max_slope_deg = 0;
    double required_fraction = 1.0;
    double max_nodata_fraction = 0.0;
};

// Validates against slope-check-request.schema.json. Throws ValidationError with every issue.
SlopeCheckRequest parse_slope_check_request(const json& body);
json to_json(const SlopeCheckRequest& req);  // defaults filled in
// Response-cache key (slope_cache.hpp): normalized request (defaults applied) + DEM identity.
std::string slope_cache_key(const SlopeCheckRequest& req, const DemInfo& dem);

// Full response body (slope-check-response.schema.json). dem == nullptr -> status dem_unavailable,
// with `unavailable_reason` as the explanation.
json slope_check(const SlopeCheckRequest& req, const Dem* dem, const std::string& unavailable_reason);
// Several installed DEMs, finest first: the first one whose coverage holds the whole zone is used
// (status computed); if none does, the first DEM's out_of_coverage answer, listing every product
// tried. Empty list -> dem_unavailable with `unavailable_reason`.
json slope_check_any(const SlopeCheckRequest& req, const std::vector<const Dem*>& dems,
                     const std::string& unavailable_reason);
// One-line coverage description, e.g. "LDEM_85S_20M (90S-85S, 20 m)".
std::string dem_coverage_label(const DemInfo& d);

// Planetocentric lat/lon (deg) -> fractional 0-based (line, sample) on the DEM grid.
struct GridPos {
    double line, sample;
};
GridPos dem_pixel_of(const DemInfo& d, double lat_deg, double lon_deg);
// Inverse: pixel centre -> planetocentric lat, east lon in [-180, 180) (lon = center_lon at the pole).
struct LatLon {
    double lat_deg, lon_deg;
};
LatLon dem_latlon_of(const DemInfo& d, double line, double sample);

}  // namespace selene
