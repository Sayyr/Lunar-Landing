#include "evaluate.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <memory>

#include "intervals.hpp"

namespace selene {

namespace {

const std::vector<std::string> IDEAL_HORIZON_ASSUMPTIONS = {
    "Horizon model: ideal geometric horizon (elevation 0 deg); local terrain is ignored.",
    "Visibility = body centre above the horizon; finite apparent disks (partial Sun/Earth) "
    "are not modelled.",
    "Window edges are linearly interpolated between samples; events shorter than the "
    "sampling step may be missed.",
    "Geometric visibility only: Sun visibility is not a power guarantee and Earth visibility "
    "is not a radio-link guarantee.",
};

// Round half to even, like Python's timedelta constructor.
int64_t round_us(double us) { return static_cast<int64_t>(std::nearbyint(us)); }

json warnings(const ScenarioRequest& request, const EphemerisProvider& provider) {
    json out = json::array();
    if (provider.synthetic())
        out.push_back("SYNTHETIC DATA: these numbers do not describe the real Sun or Earth.");
    if (std::fabs(request.site.latitude_deg) >= POLAR_WARNING_LAT_DEG)
        out.push_back(
            "|latitude| >= 89.0 deg: local north/azimuth is ill-conditioned near the pole (azimuths change "
            "quickly with small site moves); at the pole itself north is taken along the requested longitude's "
            "meridian.");
    return out;
}

json windows(int64_t t0, const std::vector<double>& seconds, const std::vector<double>& elevation) {
    json out = json::array();
    for (const Interval& iv : extract_intervals(seconds, elevation, 0.0))
        out.push_back({
            {"start_utc", format_utc(t0 + round_us(iv.start * 1e6))},
            {"end_utc", format_utc(t0 + round_us(iv.end * 1e6))},
            {"clipped_start", iv.clipped_start},
            {"clipped_end", iv.clipped_end},
        });
    return out;
}

json response(const char* status, bool synthetic, const std::string& message,
              const ScenarioRequest& request, json model, json provenance, json assumptions,
              json warns, json samples, json sun_windows, json earth_windows) {
    return {
        {"schema_version", SCHEMA_VERSION},
        {"status", status},
        {"synthetic", synthetic},
        {"message", message},
        {"request", to_json(request)},
        {"model", std::move(model)},
        {"data_provenance", std::move(provenance)},
        {"assumptions", std::move(assumptions)},
        {"warnings", std::move(warns)},
        {"samples", std::move(samples)},
        {"windows", {{"sun_visible", std::move(sun_windows)}, {"earth_visible", std::move(earth_windows)}}},
    };
}

json not_ready(const ScenarioRequest& request, json model, const std::string& message, json warns) {
    return response("not_ready", false, message, request, std::move(model), json::array(),
                    json::array(), std::move(warns), json::array(), json::array(), json::array());
}

// Margin (elevation - horizon) series -> windows.
json windows_above(int64_t t0, const std::vector<double>& seconds, const std::vector<double>& elevation,
                   const std::vector<double>& horizon) {
    std::vector<double> margin(elevation.size());
    for (size_t i = 0; i < elevation.size(); ++i) margin[i] = elevation[i] - horizon[i];
    return windows(t0, seconds, margin);
}

json dem_provenance(const DemInfo& d) {
    return {
        {"name", d.product_id},
        {"kind", d.synthetic ? "synthetic" : "dem"},
        {"source", d.lola_gdr ? "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/"
                              : d.file},
        {"version", d.product_version.empty() ? json(nullptr) : json(d.product_version)},
        {"license", d.lola_gdr ? json("NASA PDS data, public; credit NASA/GSFC LOLA team") : json(nullptr)},
        {"notes", "Terrain horizon DEM. Frame: " + (d.frame.empty() ? std::string("not stated in the label") : d.frame) +
                      ". Map pixel " + std::to_string(static_cast<int>(d.proj.scale_m)) + " m. SHA-256: " +
                      (d.sha256 ? *d.sha256 + " (" + d.sha256_note + ")" : d.sha256_note) + "."},
    };
}

json terrain_json(const HorizonProfile& p) {
    json levels = json::array();
    for (const HorizonLevel& l : p.levels) levels.push_back({{"max_range_m", l.max_range_m}, {"pixel_m", l.pixel_m}});
    const double n = static_cast<double>(p.elevation_deg.size());
    return {
        {"azimuth_step_deg", 360.0 / n},
        {"elevation_deg", p.elevation_deg},
        {"site_surface_height_m", p.site_surface_height_m},
        {"observer_radius_m", p.reference_radius_m + p.site_surface_height_m + p.observer_height_m},
        {"max_range_m", p.max_range_m},
        {"truncated_bearing_fraction", p.truncated_bearings / n},
        {"min_covered_range_m", p.min_covered_range_m},
        {"nodata_sample_fraction", p.samples ? static_cast<double>(p.nodata_samples) / static_cast<double>(p.samples) : 0.0},
        {"sampling", levels},
    };
}

}  // namespace

std::vector<int64_t> sample_times(const ScenarioRequest& request) {
    const int64_t start = request.start_us();
    const int64_t step = round_us(request.step_minutes * 60e6);
    std::vector<int64_t> out;
    const long long n = request.sample_count();
    out.reserve(static_cast<size_t>(n));
    for (long long i = 0; i < n; ++i) out.push_back(start + i * step);
    return out;
}

json evaluate(const ScenarioRequest& request, const EphemerisProvider& provider, const TerrainContext& terrain) {
    json model = provider.model_info();
    json warns = warnings(request, provider);
    const bool dem_mode = request.terrain_mode == "dem";

    // Terrain horizon first: it also gives the height of the ground the observer stands on.
    std::shared_ptr<const HorizonProfile> profile;
    Site site = request.site;
    if (dem_mode) {
        model["horizon_model"] = "dem_terrain";
        if (!terrain.dem)
            return not_ready(request, model, "DEM terrain horizon is not available: " + terrain.unavailable_reason, warns);
        try {
            if (terrain.cache)
                profile = terrain.cache->get(*terrain.dem, site.latitude_deg, site.longitude_deg, site.observer_height_m);
            else
                profile = std::make_shared<const HorizonProfile>(
                    terrain_horizon(*terrain.dem, site.latitude_deg, site.longitude_deg, site.observer_height_m));
        } catch (const HorizonError& e) {
            return not_ready(request, model, std::string("DEM terrain horizon is not available: ") + e.what(), warns);
        }
        // The ephemeris observer is placed at the DEM surface height, not on the reference sphere.
        site.observer_height_m += profile->site_surface_height_m;
    }

    const std::vector<int64_t> times = sample_times(request);
    DirectionSeries d;
    try {
        d = provider.directions(site, times);
    } catch (const EphemerisNotReady& e) {
        return not_ready(request, model, std::string("Ephemerides not available: ") + e.what(), warns);
    }

    const int64_t t0 = times.front();
    std::vector<double> seconds, sun_horizon(times.size(), 0.0), earth_horizon(times.size(), 0.0);
    json samples = json::array();
    for (size_t i = 0; i < times.size(); ++i) {
        seconds.push_back(static_cast<double>(times[i] - t0) / 1e6);
        json sun = {{"azimuth_deg", d.sun_azimuth_deg[i]}, {"elevation_deg", d.sun_elevation_deg[i]}};
        json earth = {{"azimuth_deg", d.earth_azimuth_deg[i]}, {"elevation_deg", d.earth_elevation_deg[i]}};
        if (profile) {
            sun["horizon_elevation_deg"] = sun_horizon[i] = horizon_elevation_deg(*profile, d.sun_azimuth_deg[i]);
            earth["horizon_elevation_deg"] = earth_horizon[i] = horizon_elevation_deg(*profile, d.earth_azimuth_deg[i]);
        }
        samples.push_back({{"utc", format_utc(times[i])}, {"sun", std::move(sun)}, {"earth", std::move(earth)}});
    }

    json assumptions = json::array();
    for (const auto& a : provider.assumptions()) assumptions.push_back(a);
    json provenance = provider.provenance();
    if (profile) {
        const HorizonProfile& p = *profile;
        char text[400];
        std::snprintf(text, sizeof text,
                      "Horizon model: DEM terrain horizon from %s, %zu bearings, rays traced to %.0f km over the "
                      "reference sphere with curvature. The observer stands on the DEM surface (%.1f m above the "
                      "%.1f km sphere) plus observer_height_m.",
                      terrain.dem->info().product_id.c_str(), p.elevation_deg.size(), p.max_range_m / 1000.0,
                      p.site_surface_height_m, p.reference_radius_m / 1000.0);
        assumptions.push_back(text);
        assumptions.push_back(
            "Terrain sampling: full DEM resolution near the site, decimated (point samples, not block maxima) "
            "farther out; a narrow distant summit can be missed, so the far horizon is a slight under-estimate. "
            "The horizon between two bearings is interpolated linearly.");
        assumptions.push_back("Visibility = body centre above the terrain horizon at its azimuth; finite apparent "
                              "disks (partial Sun/Earth) are not modelled.");
        assumptions.push_back(IDEAL_HORIZON_ASSUMPTIONS[2]);
        assumptions.push_back(IDEAL_HORIZON_ASSUMPTIONS[3]);
        provenance.push_back(dem_provenance(terrain.dem->info()));
        if (p.truncated_bearings > 0) {
            std::snprintf(text, sizeof text,
                          "Terrain beyond the DEM coverage is unknown: %.0f %% of the bearings leave the DEM before "
                          "%.0f km (the shortest after %.1f km). Relief outside the DEM is not included and could "
                          "raise the horizon there.",
                          100.0 * p.truncated_bearings / static_cast<double>(p.elevation_deg.size()),
                          p.max_range_m / 1000.0, p.min_covered_range_m / 1000.0);
            warns.push_back(text);
        }
        if (p.nodata_samples > 0) {
            std::snprintf(text, sizeof text, "%.3f %% of the terrain samples are no-data in the DEM and were skipped.",
                          100.0 * static_cast<double>(p.nodata_samples) / static_cast<double>(p.samples));
            warns.push_back(text);
        }
        if (terrain.dem->info().synthetic)
            warns.push_back("SYNTHETIC DEM: this terrain horizon does not describe the real lunar surface.");
    } else {
        for (const auto& a : IDEAL_HORIZON_ASSUMPTIONS) assumptions.push_back(a);
    }

    const bool synthetic = provider.synthetic() || (profile && terrain.dem->info().synthetic);
    json out = response(synthetic ? "synthetic" : "computed", synthetic,
                        provider.synthetic() ? "SYNTHETIC fixture output for UI development only."
                        : synthetic          ? "SYNTHETIC terrain: real ephemerides over a made-up DEM."
                        : profile            ? "Computed from SPICE ephemerides and the DEM terrain horizon."
                                             : "Computed from SPICE ephemerides.",
                        request, model, provenance, assumptions, warns, samples,
                        windows_above(t0, seconds, d.sun_elevation_deg, sun_horizon),
                        windows_above(t0, seconds, d.earth_elevation_deg, earth_horizon));
    if (profile) out["terrain_horizon"] = terrain_json(*profile);
    return out;
}

}  // namespace selene
