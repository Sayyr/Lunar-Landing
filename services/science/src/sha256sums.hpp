// Read a recorded SHA-256 from a `sha256sum`-format file ("<hex>  <name>", optional '*' binary
// marker). The hash is recorded provenance, not recomputed.
#pragma once

#include <filesystem>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>

namespace selene {

inline std::optional<std::string> sha256_from_sums(const std::filesystem::path& sums, const std::string& name) {
    std::ifstream f(sums);
    std::string line;
    while (std::getline(f, line)) {
        std::istringstream ss(line);
        std::string hex, file;
        if (!(ss >> hex >> file)) continue;
        if (!file.empty() && file[0] == '*') file.erase(0, 1);
        if (file == name && hex.size() == 64) return hex;
    }
    return std::nullopt;
}

}  // namespace selene
