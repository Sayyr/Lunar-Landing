// HTTP-agnostic request routing. main.cpp binds it to cpp-httplib; tests call it directly.
#pragma once

#include <filesystem>
#include <optional>
#include <string>

#include "ephemeris.hpp"
#include "models.hpp"

namespace selene {

constexpr const char* VERSION = "0.1.0";

struct HttpResponse {
    int status;
    json body;
};

class App {
public:
    explicit App(std::optional<std::filesystem::path> kernel_dir) : spice_(std::move(kernel_dir)) {}

    // Routes:
    //   GET  /health
    //   POST /evaluate            real ephemerides (SPICE; not ready yet)
    //   POST /evaluate/synthetic  SYNTHETIC demo data for UI development. Never use for analysis.
    HttpResponse handle(const std::string& method, const std::string& path,
                        const std::string& body) const;

private:
    HttpResponse evaluate_with(const EphemerisProvider& provider, const std::string& body) const;

    SpiceEphemerisProvider spice_;
    SyntheticEphemerisProvider synthetic_;
};

}  // namespace selene
