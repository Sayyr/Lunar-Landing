// HTTP-agnostic request routing. main.cpp binds it to cpp-httplib; tests call it directly.
#pragma once

#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "ephemeris.hpp"
#include "horizon.hpp"
#include "models.hpp"
#include "slope_cache.hpp"
#include "terrain.hpp"

namespace selene {

constexpr const char* VERSION = "0.1.0";

struct HttpResponse {
    int status;
    json body;
};

class App {
public:
    // dem: the south-polar DEM (terrain horizon, and first slope DEM). slope_dems: further DEMs for the
    // slope check, finest first (SLDEM2015 mosaic, polar 60 m products...). No DEM at all: POST
    // /terrain/slope/check answers status = dem_unavailable with dem_reason.
    explicit App(std::optional<std::filesystem::path> kernel_dir, std::shared_ptr<const Dem> dem = nullptr,
                 std::string dem_reason = "SELENE_DEM_PATH not set",
                 std::vector<std::shared_ptr<const Dem>> slope_dems = {},
                 std::optional<std::filesystem::path> trajectory_tool = std::nullopt)
        : kernel_dir_(kernel_dir), spice_(std::move(kernel_dir)), dem_(std::move(dem)), dem_reason_(std::move(dem_reason)),
          trajectory_tool_(std::move(trajectory_tool)) {
        if (dem_) slope_dems_.push_back(dem_);
        for (auto& d : slope_dems)
            if (d) slope_dems_.push_back(std::move(d));
    }

    // Routes:
    //   GET  /health
    //   POST /evaluate            real ephemerides (SPICE; not ready yet)
    //   POST /evaluate/synthetic  SYNTHETIC demo data for UI development. Never use for analysis.
    //   POST /terrain/slope/check DEM slope check of a circular zone (terrain.hpp)
    //   POST /celestial/state     Sun/Earth/Moon geometric state at one UTC instant, for the 3D views (celestial.hpp)
    //   POST /celestial/tracks    Moon and Sun orbit traces around one UTC instant, for the 3D views (celestial.hpp)
    //   POST /radio/evaluate      direct-to-Earth radio-link windows, engineering tier (radio.hpp)
    //   POST /mission/simulate    surface-stay mission simulation, engineering tier (mission.hpp)
    //   POST /mission/simulate/synthetic  the same on the SYNTHETIC ephemeris provider (UI development only)
    //   POST /trajectory/simulate Earth->Moon transfer + descent by the vecteur-traj tool (trajectory.hpp)
    HttpResponse handle(const std::string& method, const std::string& path,
                        const std::string& body) const;

    SlopeCache::Stats slope_cache_stats() const { return slope_cache_->stats(); }

private:
    HttpResponse evaluate_with(const EphemerisProvider& provider, const std::string& body) const;
    HttpResponse slope_check_route(const std::string& body) const;
    HttpResponse radio_route(const std::string& body) const;
    HttpResponse celestial_route(const std::string& body, bool tracks) const;
    HttpResponse mission_route(const EphemerisProvider& provider, const std::string& body) const;
    HttpResponse trajectory_route(const std::string& body) const;

    std::optional<std::filesystem::path> kernel_dir_;
    SpiceEphemerisProvider spice_;
    SyntheticEphemerisProvider synthetic_;
    std::shared_ptr<const Dem> dem_;  // immutable; read_window() is thread-safe
    std::string dem_reason_;
    std::vector<std::shared_ptr<const Dem>> slope_dems_;  // finest first, dem_ included
    std::vector<const Dem*> slope_dem_ptrs() const {
        std::vector<const Dem*> v;
        for (const auto& d : slope_dems_) v.push_back(d.get());
        return v;
    }
    // Thread-safe (internal mutex); shared_ptr keeps App copyable. See slope_cache.hpp.
    std::shared_ptr<SlopeCache> slope_cache_ = std::make_shared<SlopeCache>(256);
    // Terrain horizon profiles per site (horizon.hpp); thread-safe.
    std::shared_ptr<HorizonCache> horizon_cache_ = std::make_shared<HorizonCache>(64);
    // vecteur-traj executable (nullopt: POST /trajectory/simulate answers not_ready) and its results
    // by normalized request (a run takes seconds; the result is deterministic for given kernels).
    std::optional<std::filesystem::path> trajectory_tool_;
    std::shared_ptr<SlopeCache> trajectory_cache_ = std::make_shared<SlopeCache>(32);
};

}  // namespace selene
