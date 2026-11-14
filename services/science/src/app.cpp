#include "app.hpp"

#include "evaluate.hpp"

namespace selene {

namespace {

const char* INVALID = "Scenario request is invalid.";

HttpResponse validation_error(std::vector<ErrorDetail> details) {
    return {422, error_response("validation_error", INVALID, details)};
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
    return {404, error_response("not_found", "Not Found")};
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
    return {200, evaluate(req, provider)};
}

}  // namespace selene
