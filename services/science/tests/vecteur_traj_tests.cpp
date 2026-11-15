#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <limits>
#include <map>
#include <random>
#include <sstream>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "spice.hpp"

using nlohmann::json;
namespace fs = std::filesystem;

static int g_checks = 0, g_failures = 0;

static void report(const std::string& field, double gap, double threshold, bool ok) {
    ++g_checks;
    if (!ok) ++g_failures;
    std::printf("%s %s gap=%.6g threshold=%.6g\n", ok ? "ok  " : "FAIL", field.c_str(), gap, threshold);
}

static void report_text(const std::string& field, const std::string& got, const std::string& ref) {
    bool ok = got == ref;
    ++g_checks;
    if (!ok) ++g_failures;
    if (ok)
        std::printf("ok   %s identical\n", field.c_str());
    else
        std::printf("FAIL %s got=%s ref=%s\n", field.c_str(), got.c_str(), ref.c_str());
}

static std::string read_file(const fs::path& p) {
    std::ifstream in(p, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(in), {});
}

static std::vector<std::string> lines(const std::string& s) {
    std::vector<std::string> out;
    std::istringstream in(s);
    std::string l;
    while (std::getline(in, l)) {
        if (!l.empty() && l.back() == '\r') l.pop_back();
        out.push_back(l);
    }
    return out;
}

static double utc_seconds(const std::string& s) {
    int y, mo, d, h, mi;
    double sec;
    if (std::sscanf(s.c_str(), "%d-%d-%dT%d:%d:%lf", &y, &mo, &d, &h, &mi, &sec) != 6)
        return std::numeric_limits<double>::quiet_NaN();
    y -= mo <= 2;
    long era = (y >= 0 ? y : y - 399) / 400;
    long yoe = y - era * 400;
    long doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    long days = era * 146097 + doe - 719468;
    return days * 86400.0 + h * 3600.0 + mi * 60.0 + sec;
}

struct Tolerance {
    double rel;
    double utc_s;
    std::map<std::string, double> absolute;
};

static void compare(const json& got, const json& ref, const std::string& path, const std::string& key,
                    const Tolerance& tol) {
    if (got.type() != ref.type() && !(got.is_number() && ref.is_number())) {
        report_text(path + " type", got.type_name(), ref.type_name());
        return;
    }
    if (ref.is_object()) {
        for (auto it = ref.begin(); it != ref.end(); ++it) {
            if (!got.contains(it.key())) {
                report_text(path + "." + it.key(), "<missing>", it.value().dump());
                continue;
            }
            compare(got[it.key()], it.value(), path + "." + it.key(), it.key(), tol);
        }
        for (auto it = got.begin(); it != got.end(); ++it)
            if (!ref.contains(it.key())) report_text(path + "." + it.key(), it.value().dump(), "<missing>");
    } else if (ref.is_array()) {
        if (got.size() != ref.size()) {
            report(path + " size", std::fabs(double(got.size()) - double(ref.size())), 0, false);
            return;
        }
        if (tol.rel > 0 && (key == "position_j2000_km" || key == "vitesse_j2000_km_s")) {
            std::printf("skip %s (J2000 geocentrique : compare via *_moon_me)\n", path.c_str());
            return;
        }
        bool numeric = !ref.empty();
        for (std::size_t i = 0; i < ref.size(); ++i) numeric = numeric && ref[i].is_number() && got[i].is_number();
        if (numeric) {
            double dd = 0, nn = 0;
            for (std::size_t i = 0; i < ref.size(); ++i) {
                double b = ref[i].get<double>(), d = got[i].get<double>() - b;
                dd += d * d;
                nn += b * b;
            }
            double r = dd == 0 ? 0 : nn == 0 ? std::numeric_limits<double>::infinity() : std::sqrt(dd / nn);
            report(path + " (|d|/|v|)", r, tol.rel, r <= tol.rel);
            return;
        }
        for (std::size_t i = 0; i < ref.size(); ++i)
            compare(got[i], ref[i], path + "[" + std::to_string(i) + "]", key, tol);
    } else if (ref.is_number()) {
        double a = got.get<double>(), b = ref.get<double>(), d = std::fabs(a - b);
        auto abs_it = tol.absolute.find(key);
        if (abs_it != tol.absolute.end()) {
            report(path + " (abs)", d, abs_it->second, d <= abs_it->second);
        } else {
            double r = d == 0 ? 0 : b == 0 ? std::numeric_limits<double>::infinity() : d / std::fabs(b);
            report(path + " (rel)", r, tol.rel, r <= tol.rel);
        }
    } else if (ref.is_string() && key.size() > 4 && key.compare(key.size() - 4, 4, "_utc") == 0 && tol.utc_s > 0) {
        double d = std::fabs(utc_seconds(got.get<std::string>()) - utc_seconds(ref.get<std::string>()));
        report(path + " (utc s) " + got.get<std::string>() + " vs " + ref.get<std::string>(), d, tol.utc_s,
               d <= tol.utc_s);
    } else if (ref.is_string()) {
        report_text(path, got.get<std::string>(), ref.get<std::string>());
    } else {
        report_text(path, got.dump(), ref.dump());
    }
}

static void compare_json(const fs::path& got, const fs::path& ref, const Tolerance& tol) {
    std::string name = got.filename().string();
    std::printf("-- %s vs %s\n", name.c_str(), ref.parent_path().filename().string().c_str());
    if (!fs::is_regular_file(got)) {
        report_text(name, "<missing>", "present");
        return;
    }
    compare(json::parse(read_file(got)), json::parse(read_file(ref)), name, "", tol);
}

static void exact_file(const fs::path& got, const fs::path& ref) {
    std::string name = got.filename().string();
    std::string a = read_file(got), b = read_file(ref);
    std::vector<std::string> la = lines(a), lb = lines(b);
    std::size_t first = 0, n = std::max(la.size(), lb.size());
    for (std::size_t i = 0; i < n && !first; ++i)
        if (i >= la.size() || i >= lb.size() || la[i] != lb[i]) first = i + 1;
    std::printf("-- %s bytes: %zu vs %zu, lines %zu vs %zu, first differing line %zu\n", name.c_str(), a.size(),
                b.size(), la.size(), lb.size(), first);
    if (first) {
        std::printf("   got: %s\n   ref: %s\n", first <= la.size() ? la[first - 1].c_str() : "<eof>",
                    first <= lb.size() ? lb[first - 1].c_str() : "<eof>");
    }
    report(name + " (bytes differing)", a == b ? 0 : 1, 0, a == b);
}

static void csv_shape(const fs::path& got, const fs::path& ref) {
    std::vector<std::string> la = lines(read_file(got)), lb = lines(read_file(ref));
    std::string name = got.filename().string();
    report(name + " line count", std::fabs(double(la.size()) - double(lb.size())), 0, la.size() == lb.size());
    report_text(name + " header", la.empty() ? "" : la[0], lb.empty() ? "" : lb[0]);
}

static fs::path make_tmp(const std::string& tag) {
    fs::path p = fs::temp_directory_path() /
                 ("vecteur-traj-tests-" + tag + "-" + std::to_string(std::random_device{}()));
    fs::create_directories(p);
    return p;
}

static int run_binary(const std::string& args, const fs::path& out) {
    std::string cmd = std::string("\"") + VECTEUR_TRAJ_BIN + "\" " + args + " --sortie \"" + out.string() +
                      "\" > \"" + (out / "stdout.txt").string() + "\" 2>&1";
#ifdef _WIN32
    cmd = "\"" + cmd + "\"";
#endif
    int rc = std::system(cmd.c_str());
    std::printf("run: %s -> %d\n", args.c_str(), rc);
    if (rc != 0) std::printf("%s\n", read_file(out / "stdout.txt").c_str());
    return rc;
}

static const fs::path FIX = SELENE_VT_FIXTURES;
static const char* JSONS[] = {"etat_debut_alunissage.json", "bilan_alunissage.json"};
static const char* CSVS[] = {"trajectoire_avant_alunissage.csv", "alunissage.csv"};

#if defined(__linux__) && defined(__x86_64__)
static constexpr bool BIT_EXACT = true;
#else
static constexpr bool BIT_EXACT = false;
#endif

static const std::map<std::string, double> NEAR_ZERO = {{"altitude_sur_site_finale_km", 1e-9},
                                                        {"ecart_surface_site_final_km", 1e-6},
                                                        {"vitesse_finale_lunaire_ms", 1e-4},
                                                        {"vitesse_verticale_finale_ms", 1e-4},
                                                        {"vitesse_horizontale_finale_ms", 1e-4}};
static const Tolerance FRESH = BIT_EXACT ? Tolerance{0, 0, {}} : Tolerance{5e-6, 0.05, NEAR_ZERO};

static void test_alunissage() {
    std::printf("\n== 1. alunissage from python_fresh/etat_debut_alunissage.json, 3 h\n");
    fs::path out = make_tmp("alunissage");
    fs::copy_file(FIX / "python_fresh/etat_debut_alunissage.json", out / "etat_debut_alunissage.json");
    int rc = run_binary("alunissage --duree-descente-h 3", out);
    report("exit code", std::abs(rc), 0, rc == 0);
    compare_json(out / "bilan_alunissage.json", FIX / "python_fresh/bilan_alunissage.json", FRESH);
    if (BIT_EXACT) {
        exact_file(out / "bilan_alunissage.json", FIX / "python_fresh/bilan_alunissage.json");
        exact_file(out / "alunissage.csv", FIX / "python_fresh/alunissage.csv");
    } else {
        csv_shape(out / "alunissage.csv", FIX / "python_fresh/alunissage.csv");
    }
    fs::remove_all(out);
}

static void test_complet() {
    std::printf("\n== 2. complet --duree-descente-h 3 vs python_fresh (%s)\n", BIT_EXACT ? "exact" : "tolerances");
    fs::path out = make_tmp("complet");
    int rc = run_binary("complet --duree-descente-h 3", out);
    report("exit code", std::abs(rc), 0, rc == 0);
    for (const char* f : JSONS) {
        compare_json(out / f, FIX / "python_fresh" / f, FRESH);
        if (BIT_EXACT) exact_file(out / f, FIX / "python_fresh" / f);
    }
    for (const char* f : CSVS) {
        if (BIT_EXACT)
            exact_file(out / f, FIX / "python_fresh" / f);
        else
            csv_shape(out / f, FIX / "python_fresh" / f);
    }

    std::printf("\n== 3. complet --duree-descente-h 3 vs commit (tolerances)\n");
    for (const char* f : JSONS) compare_json(out / f, FIX / "commit" / f, Tolerance{1e-6, 0.025, NEAR_ZERO});
    for (const char* f : CSVS) csv_shape(out / f, FIX / "commit" / f);
    fs::remove_all(out);
}

int main() {
#ifndef VECTEUR_TRAJ_BIN
    std::printf("SKIPPED: built without CSPICE (no vecteur-traj binary)\n");
    return 77;
#else
    const char* env = std::getenv("SELENE_KERNEL_DIR");
    const fs::path kdir = env && *env ? fs::path(env) : fs::path(SELENE_DEFAULT_KERNEL_DIR);
    for (const auto& k : selene::spice::required_kernels())
        if (!fs::is_regular_file(kdir / k.name)) {
            std::printf("SKIPPED: kernel %s not found in %s (run scripts/setup-spice.sh)\n", k.name.c_str(),
                        kdir.string().c_str());
            return 77;
        }
    test_alunissage();
    test_complet();
    std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
#endif
}
