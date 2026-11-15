#pragma once

#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "scipy_port.hpp"

namespace selene::vt {

struct LsqOptions {
    Vec lb;
    Vec ub;
    double ftol = 1e-8;
    double xtol = 1e-8;
    double gtol = 1e-8;
    Vec x_scale;
    std::optional<double> diff_step;
    std::optional<int> max_nfev;
};

struct LsqResult {
    Vec x;
    double cost = 0.0;
    Vec fun;
    std::vector<Vec> jac;
    Vec grad;
    double optimality = 0.0;
    std::vector<int> active_mask;
    int nfev = 0;
    int njev = 0;
    int status = 0;
    std::string message;
    bool success = false;
};

using Residual = std::function<Vec(const Vec&)>;

LsqResult least_squares(const Residual& fun, const Vec& x0, const LsqOptions& options);

}
