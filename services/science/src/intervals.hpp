// Extract above-threshold intervals from a sampled time series.
//
// Edges are located by linear interpolation between the two samples that bracket a
// threshold crossing. Events shorter than the sampling step can be missed entirely;
// callers must surface that limitation (see docs/validation.md).
#pragma once

#include <vector>

namespace selene {

struct Interval {
    double start;
    double end;
    bool clipped_start;  // interval was already open at the first sample
    bool clipped_end;    // interval was still open at the last sample
    bool operator==(const Interval& o) const {
        return start == o.start && end == o.end && clipped_start == o.clipped_start &&
               clipped_end == o.clipped_end;
    }
};

// Maximal intervals where values > threshold. `times` must be strictly increasing
// (any monotonic numeric scale, e.g. seconds). Throws std::invalid_argument on bad input.
std::vector<Interval> extract_intervals(const std::vector<double>& times,
                                        const std::vector<double>& values,
                                        double threshold = 0.0);

}  // namespace selene
