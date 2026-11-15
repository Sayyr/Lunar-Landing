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
  src/app.cpp src/ephemeris.cpp src/ephemeris_spice.cpp src/evaluate.cpp src/geometry.cpp
  src/intervals.cpp src/link.cpp src/lunar_ephemeris.cpp src/models.cpp src/radio.cpp src/terrain.cpp)
target_include_directories(selene_science_core PUBLIC src)
target_link_libraries(selene_science_core PUBLIC nlohmann_json::nlohmann_json)

# CSPICE (NAIF toolkit), optional. scripts/setup-spice.sh installs it in third_party/cspice. Without
# it the SPICE provider is compiled as "not ready" and /evaluate answers status not_ready.
#  * prebuilt lib/cspice.a from NAIF where NAIF ships one for this platform (macOS arm64/x86_64,
#    Linux x86_64);
#  * otherwise (Windows, Linux arm64, or SELENE_CSPICE_FROM_SOURCE=ON) built here from the
#    package's own src/cspice/*.c with NAIF's mkprodct flags.
set(SELENE_CSPICE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/cspice" CACHE PATH "CSPICE toolkit root")
option(SELENE_CSPICE_FROM_SOURCE "Compile CSPICE from its sources instead of linking lib/cspice.a" OFF)
set(SELENE_HAVE_CSPICE OFF)
if(EXISTS "${SELENE_CSPICE_DIR}/include/SpiceUsr.h")
  if(NOT WIN32 AND NOT SELENE_CSPICE_FROM_SOURCE AND EXISTS "${SELENE_CSPICE_DIR}/lib/cspice.a")
    add_library(cspice STATIC IMPORTED)
    set_target_properties(cspice PROPERTIES IMPORTED_LOCATION "${SELENE_CSPICE_DIR}/lib/cspice.a")
    set(SELENE_HAVE_CSPICE ON)
    message(STATUS "CSPICE: prebuilt ${SELENE_CSPICE_DIR}/lib/cspice.a")
  elseif(EXISTS "${SELENE_CSPICE_DIR}/src/cspice/spkcpo_c.c")
    enable_language(C)
    file(GLOB CSPICE_SOURCES "${SELENE_CSPICE_DIR}/src/cspice/*.c")
    add_library(cspice STATIC ${CSPICE_SOURCES})
    target_include_directories(cspice PRIVATE "${SELENE_CSPICE_DIR}/src/cspice")
    if(MSVC)
      # mkprodct.bat; zzsecprt.c is compiled without optimisation and without NON_ANSI_STDIO.
      target_compile_definitions(cspice PRIVATE _COMPLEX_DEFINED MSDOS OMIT_BLANK_CC)
      target_compile_options(cspice PRIVATE /O2 /w)
      set_source_files_properties("${SELENE_CSPICE_DIR}/src/cspice/zzsecprt.c" PROPERTIES COMPILE_OPTIONS "/Od")
      foreach(f ${CSPICE_SOURCES})
        if(NOT f MATCHES "zzsecprt\\.c$")
          set_property(SOURCE "${f}" APPEND PROPERTY COMPILE_DEFINITIONS NON_ANSI_STDIO)
        endif()
      endforeach()
    elseif(WIN32)  # MinGW: the Windows package's sources with gcc. Not tested by CI.
      target_compile_definitions(cspice PRIVATE _COMPLEX_DEFINED MSDOS OMIT_BLANK_CC NON_ANSI_STDIO)
      target_compile_options(cspice PRIVATE -ansi -O2 -w)
    else()  # mkprodct.csh: -ansi -O2 -fPIC -DNON_UNIX_STDIO (-m64 dropped: not valid on arm64)
      target_compile_definitions(cspice PRIVATE NON_UNIX_STDIO)
      target_compile_options(cspice PRIVATE -ansi -O2 -fPIC -w)
    endif()
    set(SELENE_HAVE_CSPICE ON)
    message(STATUS "CSPICE: building from source (${SELENE_CSPICE_DIR}/src/cspice, ${CMAKE_C_COMPILER_ID})")
  endif()
endif()
if(SELENE_HAVE_CSPICE)
  # SYSTEM: CSPICE headers are not ours; keep -Wpedantic quiet on them.
  target_include_directories(selene_science_core SYSTEM PRIVATE "${SELENE_CSPICE_DIR}/include")
  target_link_libraries(selene_science_core PUBLIC cspice)
  if(NOT WIN32)
    target_link_libraries(selene_science_core PUBLIC m)
  endif()
  target_compile_definitions(selene_science_core PUBLIC SELENE_HAVE_CSPICE=1)
else()
  message(STATUS "CSPICE: not found in ${SELENE_CSPICE_DIR} (SPICE provider not ready; see scripts/setup-spice.sh)")
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

  # Port of test_validation_lunar_mission.py. Needs CSPICE at build time and the kernels at run time
  # (SELENE_KERNEL_DIR, default ../../data/kernels); without kernels it exits 77 = skipped.
  if(SELENE_HAVE_CSPICE)
    add_executable(spice-tests tests/spice_tests.cpp)
    target_include_directories(spice-tests SYSTEM PRIVATE "${SELENE_CSPICE_DIR}/include")
    target_link_libraries(spice-tests PRIVATE selene_science_core)
    target_compile_definitions(spice-tests PRIVATE
      SELENE_CONTRACTS_DIR="${CONTRACTS_DIR}"
      SELENE_DEFAULT_KERNEL_DIR="${CMAKE_CURRENT_SOURCE_DIR}/../../data/kernels")
    add_test(NAME spice-tests COMMAND spice-tests)
    set_tests_properties(spice-tests PROPERTIES SKIP_RETURN_CODE 77)
  endif()

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
