cmake_minimum_required(VERSION 3.20)
project(selene_science VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

option(SELENE_BUILD_TESTS "Build tests and the fixture generator" ON)
option(SELENE_SANITIZE "Build with AddressSanitizer + UndefinedBehaviorSanitizer" OFF)
option(SELENE_FUZZ "Build the libFuzzer target fuzz-handler (clang only)" OFF)
if(SELENE_SANITIZE)
  add_compile_options(-fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()
if(SELENE_FUZZ)
  add_compile_options(-fsanitize=fuzzer-no-link,address,undefined -fno-sanitize-recover=all)
  add_link_options(-fsanitize=address,undefined)
endif()

# Header-only dependencies, pinned by version and checksum, fetched at configure time.
include(FetchContent)
if(POLICY CMP0135)
  cmake_policy(SET CMP0135 NEW)  # extracted files get extraction-time timestamps
endif()
FetchContent_Declare(nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
  URL_HASH SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d)
FetchContent_Declare(httplib
  URL https://raw.githubusercontent.com/yhirose/cpp-httplib/v0.18.3/httplib.h
  URL_HASH SHA256=a0a0c13dc086663863dbe6730a19716f7d3744904b6205496e8301750814dbd5
  DOWNLOAD_NO_EXTRACT TRUE)
FetchContent_MakeAvailable(nlohmann_json httplib)
find_package(Threads REQUIRED)

add_library(selene_science_core STATIC
  src/app.cpp src/ephemeris.cpp src/evaluate.cpp src/geometry.cpp src/intervals.cpp src/models.cpp src/terrain.cpp)
target_include_directories(selene_science_core PUBLIC src)
target_link_libraries(selene_science_core PUBLIC nlohmann_json::nlohmann_json)
if(MSVC)
  target_compile_options(selene_science_core PUBLIC /W4)
else()
  target_compile_options(selene_science_core PUBLIC -Wall -Wextra -Wpedantic)
endif()

add_executable(selene-science src/main.cpp)
target_include_directories(selene-science PRIVATE ${httplib_SOURCE_DIR})
target_link_libraries(selene-science PRIVATE selene_science_core Threads::Threads)
# httplib defaults (listen backlog 5, ~8 worker threads) reset connections under concurrent load.
target_compile_definitions(selene-science PRIVATE CPPHTTPLIB_LISTEN_BACKLOG=1024 CPPHTTPLIB_THREAD_POOL_COUNT=64)
if(WIN32)
  target_link_libraries(selene-science PRIVATE ws2_32)
endif()

if(SELENE_BUILD_TESTS)
  set(CONTRACTS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../packages/contracts")

  enable_testing()
  add_executable(selene-science-tests tests/tests.cpp)
  target_link_libraries(selene-science-tests PRIVATE selene_science_core)
  target_compile_definitions(selene-science-tests PRIVATE SELENE_CONTRACTS_DIR="${CONTRACTS_DIR}")
  add_test(NAME selene-science-tests COMMAND selene-science-tests)

  add_executable(generate-fixtures tools/generate_fixtures.cpp)
  target_link_libraries(generate-fixtures PRIVATE selene_science_core)
  target_compile_definitions(generate-fixtures PRIVATE SELENE_CONTRACTS_DIR="${CONTRACTS_DIR}")
endif()

# Offline terrain slope/aspect tiler (not part of the service). OpenMP is optional; on macOS with
# AppleClang pass e.g. -DOpenMP_ROOT=$(brew --prefix libomp).
add_executable(slope-tiles EXCLUDE_FROM_ALL tools/slope_tiles.cpp)
target_include_directories(slope-tiles PRIVATE src)
target_link_libraries(slope-tiles PRIVATE nlohmann_json::nlohmann_json)
find_package(OpenMP QUIET COMPONENTS CXX)
if(OpenMP_CXX_FOUND)
  target_link_libraries(slope-tiles PRIVATE OpenMP::OpenMP_CXX)
  message(STATUS "slope-tiles: OpenMP enabled")
else()
  message(STATUS "slope-tiles: OpenMP not found, building single-threaded")
endif()
if(NOT MSVC)
  target_compile_options(slope-tiles PRIVATE -Wall -Wextra -Wpedantic)
endif()
if(SELENE_BUILD_TESTS)
  add_executable(slope-tests tests/slope_tests.cpp)
  target_include_directories(slope-tests PRIVATE src)
  if(NOT MSVC)
    target_compile_options(slope-tests PRIVATE -Wall -Wextra -Wpedantic)
  endif()
  add_test(NAME slope-tests COMMAND slope-tests)
endif()

if(SELENE_FUZZ)
  add_executable(fuzz-handler tests/fuzz.cpp)
  target_link_libraries(fuzz-handler PRIVATE selene_science_core)
  target_link_options(fuzz-handler PRIVATE -fsanitize=fuzzer)
endif()
