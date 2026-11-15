// Regenerate packages/contracts/fixtures/{scenario,slope-check,radio-link}-response.*.json from the service code.
//
// Build and run from services/science:
//   cmake --build build --target generate-fixtures && ./build/generate-fixtures
// The synthetic scenario fixture uses a coarse 6 h step to stay small; it is SYNTHETIC data. The
// slope-check synthetic-dem fixture runs on a SYNTHETIC tilted plane (tests/synthetic_dem.hpp).

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>

#include "../tests/synthetic_dem.hpp"
#include "app.hpp"

namespace fs = std::filesystem;
using selene::json;

static const fs::path FIXTURES = fs::path(SELENE_CONTRACTS_DIR) / "fixtures";

static void write(const char* name, const json& data) {
    std::ofstream(FIXTURES / name) << data.dump(2) << "\n";
    std::printf("wrote %s\n", (FIXTURES / name).string().c_str());
}

int main() {
    const selene::App app(std::nullopt);
    json request = json::parse(std::ifstream(FIXTURES / "scenario-request.valid.json"));
    write("scenario-response.not-ready.json", app.handle("POST", "/evaluate", request.dump()).body);
    request["duration_hours"] = 48;
    request["step_minutes"] = 360;
    write("scenario-response.synthetic.json",
          app.handle("POST", "/evaluate/synthetic", request.dump()).body);
    json slope = json::parse(std::ifstream(FIXTURES / "slope-check-request.valid.json"));
    write("slope-check-response.dem-unavailable.json", app.handle("POST", "/terrain/slope/check", slope.dump()).body);
    const selene::App tilted(std::nullopt, selene::testing::tilted_plane_dem(8.0));
    write("slope-check-response.synthetic-dem.json",
          tilted.handle("POST", "/terrain/slope/check", selene::testing::synthetic_fixture_request().dump()).body);
    json radio = json::parse(std::ifstream(FIXTURES / "radio-link-request.valid.json"));
    write("radio-link-response.computed.json", app.handle("POST", "/radio/evaluate", radio.dump()).body);
    // Needs real kernels (SELENE_KERNEL_DIR); skipped otherwise so the other fixtures still regenerate.
    const char* kernels = std::getenv("SELENE_KERNEL_DIR");
    const selene::App live(kernels && *kernels ? std::optional<fs::path>(kernels) : std::nullopt);
    json celestial = json::parse(std::ifstream(FIXTURES / "celestial-state-request.valid.json"));
    const selene::HttpResponse state = live.handle("POST", "/celestial/state", celestial.dump());
    if (state.status == 200)
        write("celestial-state-response.computed.json", state.body);
    else
        std::printf("skipped celestial-state-response.computed.json: %s\n",
                    state.body["error"]["message"].get<std::string>().c_str());
    return 0;
}
