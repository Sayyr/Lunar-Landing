#include "app.hpp"

#include "celestial.hpp"
#include "evaluate.hpp"
#include "radio.hpp"
#include "spice.hpp"

namespace selene {

namespace {

const char* INVALID = "Scenario request is invalid.";

HttpResponse validation_error(std::vector<ErrorDetail> details, const char* message = INVALID) {
    return {422, error_response("validation_error", message, details)};
}

}  // namespace

HttpResponse App::handle(const std::string& method, const std::string& path,
                         const std::string& body) const {
    if (path == "/health") {
        if (method != "GET") return {405, error_response("not_found", "Method Not Allowed")};
        ProviderStatus s = spice_.status();
        return {200,
                {{"service", "science"},
                 {"status", "ok"},
                 {"version", VERSION},
                 {"ephemeris", {{"provider", spice_.kind()}, {"ready", s.ready}, {"reason", s.reason}}}}};
    }
    if (path == "/evaluate" || path == "/evaluate/synthetic") {
        if (method != "POST") return {405, error_response("not_found", "Method Not Allowed")};
        return evaluate_with(path == "/evaluate" ? static_cast<const EphemerisProvider&>(spice_)
                                                 : synthetic_,
                             body);
    }
    if (path == "/terrain/slope/check") {
        if (method != "POST") return {405, error_response("not_found", "Method Not Allowed")};
        return slope_check_route(body);
    }
    if (path == "/celestial/state") {
        if (method != "POST") return {405, error_response("not_found", "Method Not Allowed")};
        return celestial_route(body);
    }
    if (path == "/radio/evaluate") {
        if (method != "POST") return {405, error_response("not_found", "Method Not Allowed")};
        return radio_route(body);
    }
    return {404, error_response("not_found", "Not Found")};
}

HttpResponse App::slope_check_route(const std::string& body) const {
    static const char* SLOPE_INVALID = "Slope check request is invalid.";
    if (body.empty()) return validation_error({{"", "Field required"}}, SLOPE_INVALID);
    json parsed = json::parse(body, nullptr, /*allow_exceptions=*/false);
    if (parsed.is_discarded()) return validation_error({{"", "JSON decode error"}}, SLOPE_INVALID);
    SlopeCheckRequest req;
    try {
        req = parse_slope_check_request(parsed);
    } catch (const ValidationError& e) {
        return validation_error(e.details, SLOPE_INVALID);
    }
    if (!dem_) return {200, slope_check(req, nullptr, dem_reason_)};  // cheap, not cached
    const std::string key = slope_cache_key(req, dem_->info());
    if (auto hit = slope_cache_->get(key)) return {200, std::move(*hit)};
    try {
        json out = slope_check(req, dem_.get(), dem_reason_);
        slope_cache_->put(key, out);
        return {200, std::move(out)};
    } catch (const std::exception& e) {  // DEM I/O failure: never a fabricated verdict
        return {500, error_response("internal_error", std::string("Slope check failed: ") + e.what())};
    }
}

HttpResponse App::celestial_route(const std::string& body) const {
    static const char* CELESTIAL_INVALID = "Celestial state request is invalid.";
    if (body.empty()) return validation_error({{"", "Field required"}}, CELESTIAL_INVALID);
    json parsed = json::parse(body, nullptr, /*allow_exceptions=*/false);
    if (parsed.is_discarded()) return validation_error({{"", "JSON decode error"}}, CELESTIAL_INVALID);
    int64_t utc_us = 0;
    try {
        utc_us = parse_celestial_state_request(parsed);
    } catch (const ValidationError& e) {
        return validation_error(e.details, CELESTIAL_INVALID);
    }
    // No kernels, or an epoch outside them: an explicit error, never invented positions.
    const ProviderStatus s = spice_.status();
    if (!s.ready) return {503, error_response("science_unavailable", "Ephemerides not available: " + s.reason)};
    try {
        return {200, celestial_state(utc_us)};
    } catch (const spice::Error& e) {
        return {503, error_response("science_unavailable", std::string("Ephemerides not available: ") + e.what())};
    }
}

HttpResponse App::radio_route(const std::string& body) const {
    static const char* RADIO_INVALID = "Radio link request is invalid.";
    if (body.empty()) return validation_error({{"", "Field required"}}, RADIO_INVALID);
    json parsed = json::parse(body, nullptr, /*allow_exceptions=*/false);
    if (parsed.is_discarded()) return validation_error({{"", "JSON decode error"}}, RADIO_INVALID);
    RadioLinkRequest req;
    try {
        req = parse_radio_link_request(parsed);
    } catch (const ValidationError& e) {
        return validation_error(e.details, RADIO_INVALID);
    }
    if (req.scenario.sample_count() > MAX_SAMPLES)
        return validation_error({{"step_minutes", std::to_string(req.scenario.sample_count()) +
                                                      " samples exceeds the maximum of " +
                                                      std::to_string(MAX_SAMPLES)}},
                                RADIO_INVALID);
    static const int64_t LAST_US = parse_utc("9999-12-31T23:59:59.999999Z");
    if (sample_times(req.scenario).back() > LAST_US)
        return validation_error({{"duration_hours", "scenario would end after 9999-12-31T23:59:59Z"}},
                                RADIO_INVALID);
    return {200, evaluate_radio_link(req)};
}

HttpResponse App::evaluate_with(const EphemerisProvider& provider, const std::string& body) const {
    if (body.empty()) return validation_error({{"", "Field required"}});
    json parsed = json::parse(body, nullptr, /*allow_exceptions=*/false);
    if (parsed.is_discarded()) return validation_error({{"", "JSON decode error"}});

    ScenarioRequest req;
    try {
        req = parse_request(parsed);
    } catch (const ValidationError& e) {
        return validation_error(e.details);
    }
    if (req.sample_count() > MAX_SAMPLES)
        return validation_error({{"step_minutes", std::to_string(req.sample_count()) +
                                                      " samples exceeds the maximum of " +
                                                      std::to_string(MAX_SAMPLES)}});
    // Output timestamps are 4-digit-year ISO 8601; refuse grids that run past year 9999.
    static const int64_t LAST_US = parse_utc("9999-12-31T23:59:59.999999Z");
    if (sample_times(req).back() > LAST_US)
        return validation_error({{"duration_hours", "scenario would end after 9999-12-31T23:59:59Z"}});
    return {200, evaluate(req, provider)};
}

}  // namespace selene
