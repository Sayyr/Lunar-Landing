#pragma once

#include <array>
#include <cfloat>
#include <cstddef>
#include <functional>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace selene::vt {

using Vec = std::vector<double>;

constexpr double EPS = DBL_EPSILON;
constexpr double INF = std::numeric_limits<double>::infinity();

struct ValueError : std::invalid_argument {
    using std::invalid_argument::invalid_argument;
};

double pypow(double a, double b);
double npdot(const double* a, const double* b, std::size_t n);
double npdot(const Vec& a, const Vec& b);
double npnorm(const Vec& v);
double npnorm(const double* v, std::size_t n);
std::array<double, 6> matvec6(const double (&m)[6][6], const double* x);
Vec gemv_n(const std::vector<Vec>& K, std::size_t s, const double* a, std::size_t m);
double gemv_t_dot(const double* a, std::size_t stride, const double* x, std::size_t len, std::size_t col, std::size_t ncols);

Vec linspace(double start, double stop, long num);

double brentq(const std::function<double(double)>& f, double a, double b, double xtol = 2e-12,
              double rtol = 4 * EPS, int maxiter = 100);

class CubicSpline {
public:
    CubicSpline() = default;
    CubicSpline(const Vec& x, const std::vector<Vec>& y);
    Vec operator()(double t) const;

private:
    Vec x_;
    std::vector<std::array<Vec, 4>> c_;
};

struct ScalarMinResult {
    double x;
    double fun;
    bool success;
    int status;
    int nfev;
};

ScalarMinResult minimize_scalar_bounded(const std::function<double(double)>& f, double lo, double hi,
                                        double xatol = 1e-5, int maxiter = 500);

using Rhs = std::function<Vec(double, const Vec&)>;

struct Event {
    std::function<double(double, const Vec&)> g;
    bool terminal = false;
    double direction = 0.0;
};

struct IvpOptions {
    double rtol = 1e-3;
    double atol = 1e-6;
    double max_step = INF;
    std::optional<double> first_step;
    bool dense_output = false;
};

struct DenseSegment {
    double t_old = 0.0;
    double t = 0.0;
    double h = 0.0;
    Vec y_old;
    std::vector<Vec> F;
    bool constant = false;
    Vec operator()(double tt) const;
};

class OdeSolution {
public:
    OdeSolution() = default;
    OdeSolution(Vec ts, std::vector<DenseSegment> segments);
    Vec operator()(double t) const;
    double t_min() const { return t_min_; }
    double t_max() const { return t_max_; }

private:
    Vec ts_;
    Vec ts_sorted_;
    std::vector<DenseSegment> segments_;
    bool ascending_ = true;
    double t_min_ = 0.0;
    double t_max_ = 0.0;
};

struct IvpResult {
    Vec t;
    std::vector<Vec> y;
    std::optional<OdeSolution> sol;
    std::vector<Vec> t_events;
    std::vector<std::vector<Vec>> y_events;
    int status = 0;
    std::string message;
    bool success = false;
    long nfev = 0;
};

IvpResult solve_ivp_dop853(const Rhs& fun, double t0, double tf, const Vec& y0, const IvpOptions& options,
                           const std::vector<Event>& events = {});

}
