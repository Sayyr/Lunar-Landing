// Regenerate packages/contracts/fixtures/scenario-response.*.json from the service code.
//
// Build and run from services/science:
//   cmake --build build --target generate-fixtures && ./build/generate-fixtures
// The synthetic fixture uses a coarse 6 h step to stay small; it is SYNTHETIC data.

#include <cstdio>
#include <filesystem>
#include <fstream>

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
    return 0;
}
