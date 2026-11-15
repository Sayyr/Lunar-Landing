// DEM-based terrain horizon of a lunar surface site (SCIENTIFIC_REFERENCE.md section 7).
//
// For each azimuth a ray is traced over the DEM at increasing ground distance; the horizon is the
// largest elevation angle of the terrain seen from the observer:
//     H(a) = max over samples of atan2(U, hor)
//     U   = (R + h_t) cos(d/R) - (R + h_site + h_obs)      (up component of observer -> terrain point)
//     hor = (R + h_t) sin(d/R)                             (horizontal component)
// with R the DEM reference sphere (1737.4 km for LOLA), d the ground distance along that sphere,
// h_t the DEM height of the sample and h_site the DEM height under the observer. Curvature is
// therefore included: on a smooth sphere this gives the dip -acos(R/(R+h_obs)), not 0.
//
// Conventions:
//  * Site latitude planetocentric, longitude east-positive, in the DEM's body-fixed frame (LOLA:
//    mean Earth / polar axis of DE421, the frame MOON_ME is aligned with). No frame conversion.
//  * Azimuth from local north toward east, same deterministic polar ENU basis as the ephemeris
//    (geometry.hpp enu_basis). Bearing j of the profile is azimuth j * 360 / N.
//  * Units: degrees and metres at this interface; the DEM stores kilometres.
//
// Sampling (LEVELS in horizon.cpp): the DEM is read at full resolution near the site and decimated
// (every k-th pixel, point-sampled, NOT block maxima) farther out, with a ray step that grows with
// distance. A narrow distant summit can therefore be missed: the far horizon is a slight
// under-estimate, by the DEM relief within one decimated pixel over the distance.
//
// Coverage: a ray stops when it leaves the grid or the product's declared coverage (85 deg S for
// LDEM_85S_20M) and is reported as truncated: terrain beyond is unknown, not flat. A site whose
// shortest ray is under HorizonOptions::min_coverage_m is refused (HorizonError) rather than given
// a falsely open horizon. No-data samples are skipped and counted. Nothing is ever filled in.
#pragma once

#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include "terrain.hpp"

namespace selene {

// The site cannot get a terrain horizon from this DEM (outside coverage, no data under the site).
struct HorizonError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

struct HorizonOptions {
    int bearings = 720;            // 0.5 deg
    double max_range_m = 150000;   // a 5 km summit is visible from ~130 km on the Moon
    // Every bearing must be covered by the DEM at least this far, else HorizonError: a ray cut
    // short would report open sky where the terrain is simply unknown. 50 km hides relief up to
    // ~720 m above the observer's level; what lies beyond a truncated ray is still reported.
    double min_coverage_m = 50000;
};

struct HorizonLevel {
    double max_range_m;  // used for samples up to this ground distance
    double pixel_m;      // DEM sampling there (map pixel size x decimation)
};

struct HorizonProfile {
    std::vector<double> elevation_deg;     // per bearing; azimuth = index * 360 / size
    std::vector<double> horizon_range_m;   // ground distance of the sample that sets the horizon
    double site_surface_height_m = 0;      // DEM height under the site, above the reference sphere
    double observer_height_m = 0;          // above that surface (request)
    double reference_radius_m = 0;
    double max_range_m = 0;
    std::vector<HorizonLevel> levels;
    int truncated_bearings = 0;            // rays that left DEM coverage before max_range_m
    double min_covered_range_m = 0;        // shortest ray (== max_range_m when none is truncated)
    long long samples = 0, nodata_samples = 0;
};

// Throws HorizonError when the site is outside the DEM's coverage or on a no-data pixel, and
// std::runtime_error on a DEM read failure.
HorizonProfile terrain_horizon(const Dem& dem, double lat_deg, double lon_deg, double observer_height_m,
                               const HorizonOptions& options = {});

// Horizon elevation toward `azimuth_deg`, linear between the two neighbouring bearings (wraps).
double horizon_elevation_deg(const HorizonProfile& profile, double azimuth_deg);

// Bounded, thread-safe LRU of computed profiles. A profile depends only on the site, the observer
// height and the DEM, so scenario evaluations of the same site (time scrub, delay sweep) reuse it.
class HorizonCache {
public:
    explicit HorizonCache(std::size_t capacity = 64);
    ~HorizonCache();
    // Returns the cached profile for (dem identity, site, height, options) or computes and stores it.
    std::shared_ptr<const HorizonProfile> get(const Dem& dem, double lat_deg, double lon_deg,
                                              double observer_height_m, const HorizonOptions& options = {});
    struct Stats {
        std::size_t hits, misses, size;
    };
    Stats stats() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace selene
