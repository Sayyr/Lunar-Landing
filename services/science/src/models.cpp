#include "models.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <initializer_list>

namespace selene {

namespace {

const char* UTC_PATTERN_TEXT = R"(^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$)";

struct UtcFields {
    int year, month, day, hour, minute, second;
    std::string fraction;  // digits after '.', possibly empty
};

// Hand-written matcher for UTC_PATTERN_TEXT (ASCII digits only). Deliberately not std::regex:
// libstdc++'s regex recurses per character and overflows the stack on long inputs.
bool match_utc(const std::string& s, UtcFields& f) {
    size_t i = 0;
    auto digits = [&](size_t n, int& out) {
        out = 0;
        for (size_t k = 0; k < n; ++k, ++i) {
            if (i >= s.size() || s[i] < '0' || s[i] > '9') return false;
            out = out * 10 + (s[i] - '0');
        }
        return true;
    };
    auto lit = [&](char c) { return i < s.size() && s[i++] == c; };
    if (!(digits(4, f.year) && lit('-') && digits(2, f.month) && lit('-') && digits(2, f.day) &&
          lit('T') && digits(2, f.hour) && lit(':') && digits(2, f.minute) && lit(':') &&
          digits(2, f.second)))
        return false;
    f.fraction.clear();
    if (i < s.size() && s[i] == '.') {
        size_t start = ++i;
        while (i < s.size() && s[i] >= '0' && s[i] <= '9') ++i;
        if (i == start) return false;
        f.fraction = s.substr(start, std::min<size_t>(i - start, 6));
    }
    return i + 1 == s.size() && s[i] == 'Z';
}

constexpr int64_t US_PER_DAY = 86400LL * 1000000LL;

// Howard Hinnant's days_from_civil / civil_from_days (proleptic Gregorian calendar).
int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

void civil_from_days(int64_t z, int64_t& y, unsigned& m, unsigned& d) {
    z += 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned doe = static_cast<unsigned>(z - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    d = doy - (153 * mp + 2) / 5 + 1;
    m = mp < 10 ? mp + 3 : mp - 9;
    y = static_cast<int64_t>(yoe) + era * 400 + (m <= 2);
}

bool is_leap(int y) { return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0; }

int days_in_month(int y, int m) {
    static const int dim[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    return m == 2 && is_leap(y) ? 29 : dim[m - 1];
}

struct Limit {
    enum Op { GE, GT, LE, LT } op;
    double value;
};

std::string limit_message(const Limit& l) {
    char num[32];
    // Limits are integers in the contract; print them the way the schema does.
    std::snprintf(num, sizeof num, "%g", l.value);
    switch (l.op) {
        case Limit::GE: return std::string("Input should be greater than or equal to ") + num;
        case Limit::GT: return std::string("Input should be greater than ") + num;
        case Limit::LE: return std::string("Input should be less than or equal to ") + num;
        case Limit::LT: return std::string("Input should be less than ") + num;
    }
    return {};
}

bool satisfies(double x, const Limit& l) {
    switch (l.op) {
        case Limit::GE: return x >= l.value;
        case Limit::GT: return x > l.value;
        case Limit::LE: return x <= l.value;
        case Limit::LT: return x < l.value;
    }
    return false;
}

// Strict JSON numbers only (no bools or numeric strings), as the JSON Schema requires.
void read_number(const json& obj, const char* key, const std::string& path,
                 std::initializer_list<Limit> limits, double& out, std::vector<ErrorDetail>& errs) {
    auto it = obj.find(key);
    if (it == obj.end()) return errs.push_back({path, "Field required"});
    if (!it->is_number()) return errs.push_back({path, "Input should be a valid number"});
    double x = it->get<double>();
    for (const Limit& l : limits)
        if (!satisfies(x, l)) return errs.push_back({path, limit_message(l)});
    out = x;
}

void reject_extra(const json& obj, std::initializer_list<const char*> known, const std::string& prefix,
                  std::vector<ErrorDetail>& errs) {
    for (auto it = obj.begin(); it != obj.end(); ++it) {
        bool found = false;
        for (const char* k : known) found = found || it.key() == k;
        if (!found) errs.push_back({prefix + it.key(), "Extra inputs are not permitted"});
    }
}

const char* NOT_OBJECT = "Input should be a valid dictionary or object to extract fields from";

}  // namespace

int64_t parse_utc(const std::string& value) {
    UtcFields f;
    if (!match_utc(value, f)) throw std::invalid_argument("Invalid isoformat string");
    const int y = f.year, mo = f.month, d = f.day, h = f.hour, mi = f.minute, s = f.second;
    if (y < 1) throw std::invalid_argument("year " + std::to_string(y) + " is out of range");
    if (mo < 1 || mo > 12) throw std::invalid_argument("month must be in 1..12");
    if (d < 1 || d > days_in_month(y, mo)) throw std::invalid_argument("day is out of range for month");
    if (h > 23) throw std::invalid_argument("hour must be in 0..23");
    if (mi > 59) throw std::invalid_argument("minute must be in 0..59");
    if (s > 59) throw std::invalid_argument("second must be in 0..59");
    int64_t frac_us = 0;
    for (size_t k = 0; k < 6; ++k) frac_us = frac_us * 10 + (k < f.fraction.size() ? f.fraction[k] - '0' : 0);
    int64_t seconds = (days_from_civil(y, mo, d) * 86400LL) + h * 3600LL + mi * 60LL + s;
    return seconds * 1000000LL + frac_us;
}

std::string format_utc(int64_t us) {
    int64_t days = us / US_PER_DAY, rem = us % US_PER_DAY;
    if (rem < 0) rem += US_PER_DAY, --days;
    int64_t y;
    unsigned mo, d;
    civil_from_days(days, y, mo, d);
    int64_t secs = rem / 1000000;
    char buf[40];
    std::snprintf(buf, sizeof buf, "%04lld-%02u-%02uT%02lld:%02lld:%02lld.%03lldZ",
                  static_cast<long long>(y), mo, d, static_cast<long long>(secs / 3600),
                  static_cast<long long>(secs / 60 % 60), static_cast<long long>(secs % 60),
                  static_cast<long long>(rem % 1000000 / 1000));
    return buf;
}

int64_t ScenarioRequest::start_us() const { return parse_utc(start_utc); }

long long ScenarioRequest::sample_count() const {
    // Python float floor division (`a // b`), reproduced exactly for both positive operands.
    double a = duration_hours * 60, b = step_minutes;
    double mod = std::fmod(a, b), div = (a - mod) / b, floordiv = std::floor(div);
    if (div - floordiv > 0.5) floordiv += 1.0;
    return static_cast<long long>(floordiv) + 1;
}

ScenarioRequest parse_request(const json& body) {
    if (!body.is_object()) throw ValidationError(std::vector<ErrorDetail>{{"", NOT_OBJECT}});
    std::vector<ErrorDetail> errs;
    ScenarioRequest r{};

    auto site = body.find("site");
    if (site == body.end()) {
        errs.push_back({"site", "Field required"});
    } else if (!site->is_object()) {
        errs.push_back({"site", NOT_OBJECT});
    } else {
        read_number(*site, "latitude_deg", "site.latitude_deg", {{Limit::GE, -90}, {Limit::LE, 90}},
                    r.site.latitude_deg, errs);
        read_number(*site, "longitude_deg", "site.longitude_deg",
                    {{Limit::GE, -180}, {Limit::LT, 180}}, r.site.longitude_deg, errs);
        read_number(*site, "observer_height_m", "site.observer_height_m",
                    {{Limit::GE, 0}, {Limit::LE, 1000}}, r.site.observer_height_m, errs);
        reject_extra(*site, {"latitude_deg", "longitude_deg", "observer_height_m"}, "site.", errs);
    }

    auto start = body.find("start_utc");
    if (start == body.end()) {
        errs.push_back({"start_utc", "Field required"});
    } else if (!start->is_string()) {
        errs.push_back({"start_utc", "Input should be a valid string"});
    } else {
        r.start_utc = start->get<std::string>();
        UtcFields unused;
        if (!match_utc(r.start_utc, unused)) {
            errs.push_back({"start_utc", std::string("String should match pattern '") +
                                             UTC_PATTERN_TEXT + "'"});
        } else {
            try {
                parse_utc(r.start_utc);  // rejects impossible dates like 2026-02-30
            } catch (const std::invalid_argument& e) {
                errs.push_back({"start_utc", std::string("Value error, ") + e.what()});
            }
        }
    }

    read_number(body, "duration_hours", "duration_hours", {{Limit::GT, 0}, {Limit::LE, 2160}},
                r.duration_hours, errs);
    read_number(body, "step_minutes", "step_minutes", {{Limit::GE, 1}, {Limit::LE, 1440}},
                r.step_minutes, errs);

    auto terrain = body.find("terrain_mode");
    if (terrain == body.end()) {
        errs.push_back({"terrain_mode", "Field required"});
    } else if (!terrain->is_string() || (*terrain != "ideal" && *terrain != "dem")) {
        errs.push_back({"terrain_mode", "Input should be 'ideal' or 'dem'"});
    } else {
        r.terrain_mode = terrain->get<std::string>();
    }

    reject_extra(body, {"site", "start_utc", "duration_hours", "step_minutes", "terrain_mode"}, "",
                 errs);
    if (!errs.empty()) throw ValidationError(std::move(errs));
    return r;
}

json to_json(const ScenarioRequest& r) {
    return {
        {"site",
         {{"latitude_deg", r.site.latitude_deg},
          {"longitude_deg", r.site.longitude_deg},
          {"observer_height_m", r.site.observer_height_m}}},
        {"start_utc", r.start_utc},
        {"duration_hours", r.duration_hours},
        {"step_minutes", r.step_minutes},
        {"terrain_mode", r.terrain_mode},
    };
}

json error_response(const std::string& code, const std::string& message,
                    const std::vector<ErrorDetail>& details) {
    json d = json::array();
    for (const auto& e : details) d.push_back({{"field", e.field}, {"issue", e.issue}});
    return {{"error", {{"code", code}, {"message", message}, {"details", d}}}};
}

}  // namespace selene
