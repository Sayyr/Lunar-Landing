#include "trajectory.hpp"

#ifndef _WIN32
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <vector>

#ifndef _WIN32
extern char** environ;
#endif

namespace selene {

namespace fs = std::filesystem;

namespace {

// J2000 obliquity used by SPICE for ECLIPJ2000 (IAU 1976): 84381.448 arcsec.
constexpr double OBLIQUITY_RAD = 84381.448 / 3600.0 * 3.14159265358979323846 / 180.0;

std::vector<std::string> split(const std::string& s, char sep) {
    std::vector<std::string> out;
    std::string cur;
    std::istringstream in(s);
    while (std::getline(in, cur, sep)) out.push_back(cur);
    return out;
}

struct Csv {
    std::vector<std::string> header;
    std::vector<std::vector<std::string>> rows;
    int col(const std::string& name) const {
        for (std::size_t i = 0; i < header.size(); ++i)
            if (header[i] == name) return static_cast<int>(i);
        throw std::runtime_error("vecteur-traj CSV: no column " + name);
    }
};

Csv read_csv(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) throw std::runtime_error("vecteur-traj output missing: " + p.filename().string());
    Csv c;
    std::string line;
    bool first = true;
    while (std::getline(f, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (first) {
            if (line.rfind("\xEF\xBB\xBF", 0) == 0) line.erase(0, 3);  // UTF-8 BOM
            c.header = split(line, ';');
            first = false;
        } else if (!line.empty()) {
            c.rows.push_back(split(line, ';'));
        }
    }
    return c;
}

json read_json(const fs::path& p) {
    std::ifstream f(p);
    if (!f) return nullptr;
    return json::parse(f, nullptr, /*allow_exceptions=*/false);
}

// Positions (ECLIPJ2000 m) and UTC of one CSV segment.
json segment(const Csv& c, const std::string& phase) {
    const int t = c.col("date_utc"), x = c.col("x_j2000_km"), y = c.col("y_j2000_km"), z = c.col("z_j2000_km");
    const int alt = c.col("altitude_site_spherique_km"), v = c.col("vitesse_lunaire_ms");
    json utc = json::array(), pos = json::array(), alt_km = json::array(), speed = json::array();
    for (const auto& r : c.rows) {
        if (r.size() < c.header.size()) continue;
        const auto e = j2000_km_to_eclip_m(std::stod(r[x]), std::stod(r[y]), std::stod(r[z]));
        utc.push_back(r[t] + "Z");
        pos.push_back({e[0], e[1], e[2]});
        alt_km.push_back(std::stod(r[alt]));
        speed.push_back(std::stod(r[v]));
    }
    return {{"phase", phase}, {"utc", utc}, {"positions_m", pos}, {"altitude_above_site_km", alt_km},
            {"speed_relative_to_moon_m_s", speed}};
}

std::string tail_lines(const fs::path& p, int n) {
    std::ifstream f(p);
    std::vector<std::string> lines;
    std::string l;
    while (std::getline(f, l))
        if (!l.empty()) lines.push_back(l);
    std::string out;
    for (std::size_t i = lines.size() > static_cast<std::size_t>(n) ? lines.size() - n : 0; i < lines.size(); ++i)
        out += (out.empty() ? "" : " | ") + lines[i];
    return out;
}

std::string fmt_num(double v) {
    std::ostringstream o;
    o.precision(17);
    o << v;
    return o.str();
}

// Runs argv with stdout+stderr to `log`, extra environment `env_kv`. Returns the exit code.
int run_process(const std::vector<std::string>& argv, const std::string& env_kv, const fs::path& log, int timeout_s) {
#ifdef _WIN32
    (void)argv, (void)env_kv, (void)log, (void)timeout_s;
    throw std::runtime_error("trajectory simulation is not supported on Windows builds");
#else
    posix_spawn_file_actions_t fa;
    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_addopen(&fa, 1, log.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    posix_spawn_file_actions_adddup2(&fa, 1, 2);
    std::vector<char*> args;
    for (const auto& a : argv) args.push_back(const_cast<char*>(a.c_str()));
    args.push_back(nullptr);
    // Environment: ours minus the key we set (no setenv: other request threads may read it).
    const std::string key = env_kv.substr(0, env_kv.find('=') + 1);
    std::vector<char*> envp;
    for (char** e = environ; *e; ++e)
        if (std::strncmp(*e, key.c_str(), key.size()) != 0) envp.push_back(*e);
    envp.push_back(const_cast<char*>(env_kv.c_str()));
    envp.push_back(nullptr);
    pid_t pid = 0;
    const int rc = posix_spawn(&pid, args[0], &fa, nullptr, args.data(), envp.data());
    posix_spawn_file_actions_destroy(&fa);
    if (rc != 0) throw std::runtime_error("cannot start " + argv[0] + ": " + std::strerror(rc));
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(timeout_s);
    int status = 0;
    for (;;) {
        const pid_t w = waitpid(pid, &status, WNOHANG);
        if (w == pid) break;
        if (w < 0) throw std::runtime_error("waitpid failed");
        if (std::chrono::steady_clock::now() > deadline) {
            kill(pid, SIGKILL);
            waitpid(pid, &status, 0);
            throw std::runtime_error("vecteur-traj did not finish within " + std::to_string(timeout_s) + " s");
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (!WIFEXITED(status)) throw std::runtime_error("vecteur-traj was terminated by a signal");
    return WEXITSTATUS(status);
#endif
}

struct TempDir {
    fs::path path;
    TempDir() {
#ifdef _WIN32
        path = fs::temp_directory_path() / ("selene-traj-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        fs::create_directories(path);
#else
        std::string tmpl = (fs::temp_directory_path() / "selene-traj-XXXXXX").string();
        if (!mkdtemp(tmpl.data())) throw std::runtime_error("cannot create a temporary directory");
        path = tmpl;
#endif
    }
    ~TempDir() {
        std::error_code ec;
        fs::remove_all(path, ec);
    }
};

}  // namespace

std::array<double, 3> j2000_km_to_eclip_m(double x, double y, double z) {
    const double c = std::cos(OBLIQUITY_RAD), s = std::sin(OBLIQUITY_RAD);
    return {x * 1000.0, (c * y + s * z) * 1000.0, (-s * y + c * z) * 1000.0};
}

TrajectoryRequest parse_trajectory_request(const json& body) {
    using namespace validate;
    if (!body.is_object()) throw ValidationError(std::vector<ErrorDetail>{{"", NOT_OBJECT}});
    std::vector<ErrorDetail> errs;
    TrajectoryRequest r;
    auto site = body.find("site");
    if (site == body.end()) {
        errs.push_back({"site", "Field required"});
    } else if (!site->is_object()) {
        errs.push_back({"site", NOT_OBJECT});
    } else {
        read_number(*site, "latitude_deg", "site.latitude_deg", {{Limit::GE, -90}, {Limit::LE, 90}}, r.latitude_deg, errs);
        read_number(*site, "longitude_deg", "site.longitude_deg", {{Limit::GE, -180}, {Limit::LT, 180}}, r.longitude_deg, errs);
        if (site->contains("altitude_km"))
            read_number(*site, "altitude_km", "site.altitude_km", {{Limit::GE, 0}, {Limit::LE, 20}}, r.site_altitude_km, errs);
        reject_extra(*site, {"latitude_deg", "longitude_deg", "altitude_km"}, "site.", errs);
    }
    auto dep = body.find("departure_utc");
    if (dep == body.end()) {
        errs.push_back({"departure_utc", "Field required"});
    } else if (!dep->is_string()) {
        errs.push_back({"departure_utc", "Input should be a valid string"});
    } else {
        r.departure_utc = dep->get<std::string>();
        try {
            parse_utc(r.departure_utc);
        } catch (const std::exception& e) {
            errs.push_back({"departure_utc", std::string("Value error, ") + e.what()});
        }
    }
    if (body.contains("transfer_days"))
        read_number(body, "transfer_days", "transfer_days", {{Limit::GE, 2}, {Limit::LE, 10}}, r.transfer_days, errs);
    reject_extra(body, {"site", "departure_utc", "transfer_days"}, "", errs);
    if (!errs.empty()) throw ValidationError(std::move(errs));
    return r;
}

json to_json(const TrajectoryRequest& r) {
    return {{"site", {{"latitude_deg", r.latitude_deg}, {"longitude_deg", r.longitude_deg}, {"altitude_km", r.site_altitude_km}}},
            {"departure_utc", r.departure_utc},
            {"transfer_days", r.transfer_days}};
}

json simulate_trajectory(const TrajectoryRequest& req, const fs::path& tool, const fs::path& kernel_dir, int timeout_s) {
    TempDir dir;
    // SPICE str2et reads ISO "YYYY-MM-DDTHH:MM:SS(.fff)" as UTC; the contract's trailing Z is dropped.
    std::string date = req.departure_utc;
    if (!date.empty() && date.back() == 'Z') date.pop_back();
    const std::vector<std::string> argv = {tool.string(), "complet",
                                           "--lat", fmt_num(req.latitude_deg),
                                           "--lon", fmt_num(req.longitude_deg),
                                           "--alt-site", fmt_num(req.site_altitude_km),
                                           "--date", date,
                                           "--jours", fmt_num(req.transfer_days),
                                           "--sortie", dir.path.string()};
    const fs::path log = dir.path / "log.txt";
    const int code = run_process(argv, "SELENE_KERNEL_DIR=" + kernel_dir.string(), log, timeout_s);

    json out = {{"schema_version", SCHEMA_VERSION},
                {"status", "computed"},
                {"synthetic", false},
                {"message", ""},
                {"request", to_json(req)},
                {"frame", {{"name", "ECLIPJ2000"},
                           {"description", "Geocentric, ecliptic and equinox of J2000, metres (same frame as POST /celestial/*)"}}},
                {"model", {{"tool", "vecteur-traj (services/science/tools/vecteur_traj)"},
                           {"ephemerides", "CSPICE, kernels of the science service"},
                           {"tool_frame", "J2000 geocentric km, rotated to ECLIPJ2000 by the J2000 obliquity 84381.448 arcsec"}}},
                {"segments", json::array()},
                {"transfer", nullptr},
                {"descent", nullptr},
                {"assumptions", json::array({
                    "Departure from a 200 km Earth parking orbit at a fixed 10.92 km/s and departure angle 170 deg "
                    "(vecteur-traj defaults); the tool searches the transfer duration within +/- 2 days of transfer_days.",
                    "Site altitude above the 1737.4 km reference sphere: " + fmt_num(req.site_altitude_km) +
                        " km (spherical ground, no DEM).",
                    "Positions are those written by vecteur-traj, rotated J2000 -> ECLIPJ2000 for display; nothing is "
                    "re-integrated or smoothed here."})},
                {"warnings", json::array()}};
    if (code == 2 || !fs::exists(dir.path / "etat_debut_alunissage.json")) {
        out["status"] = "no_solution";
        out["message"] = "vecteur-traj found no admissible transfer for this site and date: " + tail_lines(log, 3);
        return out;
    }
    if (code != 0) throw std::runtime_error("vecteur-traj failed (exit " + std::to_string(code) + "): " + tail_lines(log, 3));

    out["segments"].push_back(segment(read_csv(dir.path / "trajectoire_avant_alunissage.csv"), "transfer"));
    out["transfer"] = read_json(dir.path / "etat_debut_alunissage.json");
    if (fs::exists(dir.path / "alunissage.csv")) {
        out["segments"].push_back(segment(read_csv(dir.path / "alunissage.csv"), "descent"));
        out["descent"] = read_json(dir.path / "bilan_alunissage.json");
    }
    out["message"] = "Transfer and descent computed by vecteur-traj.";
    // The tool's own caveats, verbatim.
    for (const json* j : {&out["transfer"], &out["descent"]}) {
        if (!j->is_object()) continue;
        for (const char* k : {"commentaire", "limite_modele"})
            if (j->contains(k) && (*j)[k].is_string()) out["warnings"].push_back("vecteur-traj: " + (*j)[k].get<std::string>());
    }
    if (out["descent"].is_object() && out["descent"].value("contact_detecte", false) == false)
        out["warnings"].push_back("The descent stopped at its time limit without touchdown: read the final altitude "
                                  "and speed before any conclusion.");
    out["warnings"].push_back("Demonstration model: unlimited propellant at constant mass, spherical Moon, simplified "
                              "guidance. Not a validated or flyable trajectory.");
    return out;
}

}  // namespace selene
