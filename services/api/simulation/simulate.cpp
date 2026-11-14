#include <chrono>
#include <cmath>
#include <exception>
#include <iostream>
#include <string>
#include <thread>

int main(int argc, char** argv) {
    if (argc != 4) {
        std::cerr << "usage: simulate <lat> <lon> <height>\n";
        return 1;
    }

    double lat;
    double lon;
    double height;
    try {
        lat = std::stod(argv[1]);
        lon = std::stod(argv[2]);
        height = std::stod(argv[3]);
    } catch (const std::exception&) {
        std::cerr << "invalid number\n";
        return 2;
    }

    std::this_thread::sleep_for(std::chrono::seconds(3));

    double sun_elevation = 90.0 - std::abs(lat);
    // SIMULATOR: placeholder numbers with no physical meaning; the label travels with them.
    std::cout << "{\"synthetic\":true"
              << ",\"note\":\"SIMULATOR OUTPUT - placeholder values, not the real Sun or Earth\""
              << ",\"lat\":" << lat
              << ",\"lon\":" << lon
              << ",\"height\":" << height
              << ",\"sun_elevation_deg\":" << sun_elevation
              << ",\"earth_elevation_deg\":-0.8"
              << ",\"sun_visible\":" << (sun_elevation > 0.0 ? "true" : "false")
              << ",\"earth_visible\":false}\n";
    return 0;
}
