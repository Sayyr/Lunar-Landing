// libFuzzer target: arbitrary bytes as a request body to every route. Any crash, sanitizer
// report or uncaught exception (including a response that cannot be serialised) is a bug.
//   cmake -S . -B build-fuzz -DCMAKE_CXX_COMPILER=clang++ -DSELENE_FUZZ=ON -DSELENE_BUILD_TESTS=OFF
//   cmake --build build-fuzz --target fuzz-handler && ./build-fuzz/fuzz-handler -max_total_time=300

#include <cstddef>
#include <cstdint>
#include <string>

#include "app.hpp"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    static const selene::App app(std::nullopt);
    const std::string body(reinterpret_cast<const char*>(data), size);
    for (const char* path : {"/evaluate", "/evaluate/synthetic", "/health"}) {
        selene::HttpResponse r = app.handle("POST", path, body);
        (void)r.body.dump();
    }
    return 0;
}
