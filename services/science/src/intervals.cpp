#include "intervals.hpp"

#include <cmath>
#include <stdexcept>

namespace selene {

static double crossing(double t0, double t1, double v0, double v1, double threshold) {
    if (v1 == v0) return t0;
    return t0 + (threshold - v0) * (t1 - t0) / (v1 - v0);
}

std::vector<Interval> extract_intervals(const std::vector<double>& t, const std::vector<double>& v,
                                        double threshold) {
    if (t.size() != v.size())
        throw std::invalid_argument("times and values must be 1-D arrays of equal length");
    if (t.empty()) return {};
    for (size_t i = 0; i < t.size(); ++i)
        if (!std::isfinite(t[i]) || !std::isfinite(v[i]))
            throw std::invalid_argument("times and values must be finite");
    for (size_t i = 1; i < t.size(); ++i)
        if (t[i] - t[i - 1] <= 0) throw std::invalid_argument("times must be strictly increasing");

    std::vector<Interval> out;
    bool open = v[0] > threshold, clipped_start = open;
    double start = t[0];

    for (size_t i = 1; i < t.size(); ++i) {
        bool above = v[i] > threshold, was_above = v[i - 1] > threshold;
        if (above && !was_above) {
            start = crossing(t[i - 1], t[i], v[i - 1], v[i], threshold);
            open = true;
            clipped_start = false;
        } else if (!above && was_above) {
            out.push_back({start, crossing(t[i - 1], t[i], v[i - 1], v[i], threshold),
                           clipped_start, false});
            open = false;
        }
    }
    if (open) out.push_back({start, t.back(), clipped_start, true});
    return out;
}

}  // namespace selene
