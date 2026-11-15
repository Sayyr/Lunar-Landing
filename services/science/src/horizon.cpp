#include "horizon.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <list>
#include <mutex>
#include <unordered_map>

#include "geometry.hpp"

namespace selene {

namespace {

// Target DEM sampling per distance band. With the 20 m LOLA grid: 20 m to 3 km, 80 m to 25 km,
// 320 m beyond. Coarser DEMs simply use their own pixel where it is already larger.
struct LevelSpec {
    double max_range_m, target_pixel_m;
};
const LevelSpec LEVELS[] = {{3000.0, 20.0}, {25000.0, 80.0}, {std::numeric_limits<double>::infinity(), 320.0}};

const double STEP_GROWTH = 0.002;  // ray step = max(half a level pixel, this x distance)

// A decimated window of the DEM held in memory for one profile computation.
struct Raster {
    int l0 = 0, s0 = 0, stride = 1, nl = 0, ns = 0;  // pixel (i, j) = full-res (l0 + i*stride, s0 + j*stride)
    std::vector<float> h;                            // km, NaN = no-data
    double max_range_m = 0;

    // Bilinear height (km) at fractional full-resolution (line, sample); NaN when outside the
    // raster or when any of the four corners is no-data.
    double at(double line, double sample) const {
        const double u = (line - l0) / stride, v = (sample - s0) / stride;
        if (!(u >= 0 && v >= 0 && u <= nl - 1 && v <= ns - 1)) return std::nan("");
        const int i = std::min(static_cast<int>(u), nl - 2), j = std::min(static_cast<int>(v), ns - 2);
        const double fu = u - i, fv = v - j;
        const float* p = &h[static_cast<std::size_t>(i) * ns + j];
        const double a = p[0], b = p[1], c = p[ns], d = p[ns + 1];
        return (a * (1 - fv) + b * fv) * (1 - fu) + (c * (1 - fv) + d * fv) * fu;  // NaN propagates
    }
};

// Reads the square of half-width `radius_m` around (line, sample), every `stride`-th pixel,
// clipped to the grid. One read_window() per kept line, so only those lines are read from disk.
Raster load(const Dem& dem, double line, double sample, double radius_m, int stride) {
    const DemInfo& d = dem.info();
    const int half = static_cast<int>(std::ceil(radius_m / d.proj.scale_m)) + 2 * stride;
    Raster r;
    r.stride = stride;
    r.l0 = std::max(0, static_cast<int>(std::floor(line)) - half);
    r.s0 = std::max(0, static_cast<int>(std::floor(sample)) - half);
    const int l1 = std::min(d.lines - 1, static_cast<int>(std::ceil(line)) + half);
    const int s1 = std::min(d.samples - 1, static_cast<int>(std::ceil(sample)) + half);
    r.nl = (l1 - r.l0) / stride + 1;
    r.ns = (s1 - r.s0) / stride + 1;
    if (r.nl < 2 || r.ns < 2) return r;  // degenerate: at() answers NaN everywhere
    r.h.resize(static_cast<std::size_t>(r.nl) * r.ns);
    if (stride == 1) {
        dem.read_window(r.l0, r.s0, r.nl, r.ns, r.h.data());
    } else {
        const int width = (r.ns - 1) * stride + 1;
        std::vector<float> row(static_cast<std::size_t>(width));
        for (int i = 0; i < r.nl; ++i) {
            dem.read_window(r.l0 + i * stride, r.s0, 1, width, row.data());
            for (int j = 0; j < r.ns; ++j) r.h[static_cast<std::size_t>(i) * r.ns + j] = row[static_cast<std::size_t>(j) * stride];
        }
    }
    return r;
}

std::string cache_key(const Dem& dem, double lat, double lon, double height, const HorizonOptions& o) {
    char buf[160];
    std::snprintf(buf, sizeof buf, "|%.7f|%.7f|%.3f|%d|%.1f|%.1f", lat, lon, height, o.bearings, o.max_range_m,
                  o.min_coverage_m);
    return dem.info().identity + buf;
}

}  // namespace

HorizonProfile terrain_horizon(const Dem& dem, double lat_deg, double lon_deg, double observer_height_m,
                               const HorizonOptions& options) {
    const DemInfo& info = dem.info();
    const double R = info.proj.radius_m;
    const auto covered = [&](double lat, double line, double sample) {
        return line >= 0 && sample >= 0 && line <= info.lines - 1 && sample <= info.samples - 1 &&
               (!info.max_latitude_deg || lat <= *info.max_latitude_deg);
    };

    const GridPos site = dem_pixel_of(info, lat_deg, lon_deg);
    if (!covered(lat_deg, site.line, site.sample))
        throw HorizonError("the site is outside the coverage of DEM " + info.product_id);

    HorizonProfile out;
    std::vector<Raster> rasters;
    double previous_range = 0;
    for (const LevelSpec& spec : LEVELS) {
        if (previous_range >= options.max_range_m) break;
        const int stride = std::max(1, static_cast<int>(std::lround(spec.target_pixel_m / info.proj.scale_m)));
        const double range = std::min(spec.max_range_m, options.max_range_m);
        Raster r = load(dem, site.line, site.sample, range, stride);
        r.max_range_m = range;
        out.levels.push_back({range, info.proj.scale_m * stride});
        rasters.push_back(std::move(r));
        previous_range = range;
    }

    const double site_km = rasters.front().at(site.line, site.sample);
    if (!std::isfinite(site_km)) throw HorizonError("DEM " + info.product_id + " has no data under the site");

    const double observer_radius = R + site_km * 1000.0 + observer_height_m;
    const EnuBasis enu = enu_basis(deg_to_rad(lat_deg), deg_to_rad(lon_deg));
    const int n = options.bearings;
    out.elevation_deg.assign(static_cast<std::size_t>(n), -90.0);
    out.horizon_range_m.assign(static_cast<std::size_t>(n), 0.0);
    out.site_surface_height_m = site_km * 1000.0;
    out.observer_height_m = observer_height_m;
    out.reference_radius_m = R;
    out.max_range_m = options.max_range_m;
    out.min_covered_range_m = options.max_range_m;

    for (int j = 0; j < n; ++j) {
        const double az = 2.0 * PI * j / n;
        // Unit horizontal direction of this bearing in the body-fixed frame.
        Vec3 dir;
        for (int k = 0; k < 3; ++k) dir[k] = std::cos(az) * enu.north[k] + std::sin(az) * enu.east[k];

        std::size_t level = 0;
        double best = -PI / 2, best_range = 0, reached = 0;
        bool truncated = false;
        for (double d = 0.5 * out.levels[0].pixel_m; d <= options.max_range_m;) {
            while (level + 1 < rasters.size() && d > rasters[level].max_range_m) ++level;
            const double delta = d / R, cd = std::cos(delta), sd = std::sin(delta);
            // Ground point on the reference sphere at distance d along the bearing.
            const double x = cd * enu.up[0] + sd * dir[0], y = cd * enu.up[1] + sd * dir[1],
                         z = cd * enu.up[2] + sd * dir[2];
            const double lat = rad_to_deg(std::asin(std::clamp(z, -1.0, 1.0))), lon = rad_to_deg(std::atan2(y, x));
            const GridPos p = dem_pixel_of(info, lat, lon);
            if (!covered(lat, p.line, p.sample)) {
                truncated = true;
                break;
            }
            reached = d;
            ++out.samples;
            const double h_km = rasters[level].at(p.line, p.sample);
            if (std::isfinite(h_km)) {
                const double rt = R + h_km * 1000.0;
                const double elevation = std::atan2(rt * cd - observer_radius, rt * sd);
                if (elevation > best) best = elevation, best_range = d;
            } else {
                ++out.nodata_samples;
            }
            d += std::max(0.5 * out.levels[level].pixel_m, STEP_GROWTH * d);
        }
        out.elevation_deg[static_cast<std::size_t>(j)] = rad_to_deg(best);
        out.horizon_range_m[static_cast<std::size_t>(j)] = best_range;
        if (truncated) {
            ++out.truncated_bearings;
            out.min_covered_range_m = std::min(out.min_covered_range_m, reached);
        }
        if (best_range == 0 && !truncated)
            throw HorizonError("DEM " + info.product_id + " has no data along azimuth " + std::to_string(360.0 * j / n) + " deg");
    }
    const double needed = std::min(options.min_coverage_m, options.max_range_m);
    if (out.min_covered_range_m < needed) {
        char text[200];
        std::snprintf(text, sizeof text,
                      "the site is too close to the edge of DEM %s: terrain is known only %.1f km away in some "
                      "directions, %.0f km needed",
                      info.product_id.c_str(), out.min_covered_range_m / 1000.0, needed / 1000.0);
        throw HorizonError(text);
    }
    return out;
}

double horizon_elevation_deg(const HorizonProfile& profile, double azimuth_deg) {
    const std::size_t n = profile.elevation_deg.size();
    const double x = wrap_azimuth_deg(azimuth_deg) / 360.0 * static_cast<double>(n);
    const std::size_t i = static_cast<std::size_t>(x) % n;
    const double f = x - std::floor(x);
    return profile.elevation_deg[i] * (1 - f) + profile.elevation_deg[(i + 1) % n] * f;
}

// ---- cache ----

struct HorizonCache::Impl {
    using Entry = std::pair<std::string, std::shared_ptr<const HorizonProfile>>;
    std::size_t capacity;
    mutable std::mutex m;
    std::list<Entry> lru;
    std::unordered_map<std::string, std::list<Entry>::iterator> index;
    std::size_t hits = 0, misses = 0;
};

HorizonCache::HorizonCache(std::size_t capacity) : impl_(new Impl) { impl_->capacity = capacity; }
HorizonCache::~HorizonCache() = default;

std::shared_ptr<const HorizonProfile> HorizonCache::get(const Dem& dem, double lat_deg, double lon_deg,
                                                        double observer_height_m, const HorizonOptions& options) {
    const std::string key = cache_key(dem, lat_deg, lon_deg, observer_height_m, options);
    {
        std::lock_guard<std::mutex> lock(impl_->m);
        auto it = impl_->index.find(key);
        if (it != impl_->index.end()) {
            impl_->lru.splice(impl_->lru.begin(), impl_->lru, it->second);
            ++impl_->hits;
            return it->second->second;
        }
        ++impl_->misses;
    }
    // Computed outside the lock: two concurrent misses on one key both compute the same result.
    auto profile = std::make_shared<const HorizonProfile>(terrain_horizon(dem, lat_deg, lon_deg, observer_height_m, options));
    std::lock_guard<std::mutex> lock(impl_->m);
    if (impl_->index.find(key) == impl_->index.end()) {
        impl_->lru.emplace_front(key, profile);
        impl_->index[key] = impl_->lru.begin();
        if (impl_->lru.size() > impl_->capacity) {
            impl_->index.erase(impl_->lru.back().first);
            impl_->lru.pop_back();
        }
    }
    return profile;
}

HorizonCache::Stats HorizonCache::stats() const {
    std::lock_guard<std::mutex> lock(impl_->m);
    return {impl_->hits, impl_->misses, impl_->lru.size()};
}

}  // namespace selene
