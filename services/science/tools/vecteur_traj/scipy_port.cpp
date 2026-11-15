#include "scipy_port.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>

namespace selene::vt {

namespace {

double (*volatile pow_ptr)(double, double) = static_cast<double (*)(double, double)>(std::pow);

constexpr double C_ALL[16] = {0.0, 0.05260015195876773, 0.0789002279381516, 0.1183503419072274, 0.2816496580927726, 0.3333333333333333, 0.25, 0.3076923076923077, 0.6512820512820513, 0.6, 0.8571428571428571, 1.0, 1.0, 0.1, 0.2, 0.7777777777777778};
constexpr double A_ALL[16][16] = {
    {0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.05260015195876773, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.0197250569845379, 0.0591751709536137, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.02958758547680685, 0.0, 0.08876275643042054, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.2413651341592667, 0.0, -0.8845494793282861, 0.924834003261792, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.037037037037037035, 0.0, 0.0, 0.17082860872947386, 0.12546768756682242, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.037109375, 0.0, 0.0, 0.17025221101954405, 0.06021653898045596, -0.017578125, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.03709200011850479, 0.0, 0.0, 0.17038392571223998, 0.10726203044637328, -0.015319437748624402, 0.008273789163814023, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.6241109587160757, 0.0, 0.0, -3.3608926294469414, -0.868219346841726, 27.59209969944671, 20.154067550477894, -43.48988418106996, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.47766253643826434, 0.0, 0.0, -2.4881146199716677, -0.590290826836843, 21.230051448181193, 15.279233632882423, -33.28821096898486, -0.020331201708508627, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {-0.9371424300859873, 0.0, 0.0, 5.186372428844064, 1.0914373489967295, -8.149787010746927, -18.52006565999696, 22.739487099350505, 2.4936055526796523, -3.0467644718982196, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0},
    {2.273310147516538, 0.0, 0.0, -10.53449546673725, -2.0008720582248625, -17.9589318631188, 27.94888452941996, -2.8589982771350235, -8.87285693353063, 12.360567175794303, 0.6433927460157636, 0.0, 0.0, 0.0, 0.0, 0.0},
    {0.054293734116568765, 0.0, 0.0, 0.0, 0.0, 4.450312892752409, 1.8915178993145003, -5.801203960010585, 0.3111643669578199, -0.1521609496625161, 0.20136540080403034, 0.04471061572777259, 0.0, 0.0, 0.0, 0.0},
    {0.056167502283047954, 0.0, 0.0, 0.0, 0.0, 0.0, 0.25350021021662483, -0.2462390374708025, -0.12419142326381637, 0.15329179827876568, 0.00820105229563469, 0.007567897660545699, -0.008298, 0.0, 0.0, 0.0},
    {0.03183464816350214, 0.0, 0.0, 0.0, 0.0, 0.028300909672366776, 0.053541988307438566, -0.05492374857139099, 0.0, 0.0, -0.00010834732869724932, 0.0003825710908356584, -0.00034046500868740456, 0.1413124436746325, 0.0, 0.0},
    {-0.42889630158379194, 0.0, 0.0, 0.0, 0.0, -4.697621415361164, 7.683421196062599, 4.06898981839711, 0.3567271874552811, 0.0, 0.0, 0.0, -0.0013990241651590145, 2.9475147891527724, -9.15095847217987, 0.0},
};
constexpr double E3[13] = {-0.18980075407240762, 0.0, 0.0, 0.0, 0.0, 4.450312892752409, 1.8915178993145003, -5.801203960010585, -0.4226823213237919, -0.1521609496625161, 0.20136540080403034, 0.02265179219836082, 0.0};
constexpr double E5[13] = {0.01312004499419488, 0.0, 0.0, 0.0, 0.0, -1.2251564463762044, -0.4957589496572502, 1.6643771824549864, -0.35032884874997366, 0.3341791187130175, 0.08192320648511571, -0.022355307863886294, 0.0};
constexpr double D_INT[4][16] = {
    {-8.428938276109013, 0.0, 0.0, 0.0, 0.0, 0.5667149535193777, -3.0689499459498917, 2.38466765651207, 2.117034582445028, -0.871391583777973, 2.2404374302607883, 0.6315787787694688, -0.08899033645133331, 18.148505520854727, -9.194632392478356, -4.436036387594894},
    {10.427508642579134, 0.0, 0.0, 0.0, 0.0, 242.28349177525817, 165.20045171727028, -374.5467547226902, -22.113666853125306, 7.733432668472264, -30.674084731089398, -9.332130526430229, 15.697238121770845, -31.139403219565178, -9.35292435884448, 35.81684148639408},
    {19.985053242002433, 0.0, 0.0, 0.0, 0.0, -387.0373087493518, -189.17813819516758, 527.8081592054236, -11.57390253995963, 6.8812326946963, -1.0006050966910838, 0.7777137798053443, -2.778205752353508, -60.19669523126412, 84.32040550667716, 11.99229113618279},
    {-25.69393346270375, 0.0, 0.0, 0.0, 0.0, -154.18974869023643, -231.5293791760455, 357.6391179106141, 93.40532418362432, -37.45832313645163, 104.0996495089623, 29.8402934266605, -43.53345659001114, 96.32455395918828, -39.17726167561544, -149.72683625798564},
};

constexpr int N_STAGES = 12;
constexpr int N_STAGES_EXTENDED = 16;
constexpr int INTERPOLATOR_POWER = 7;
constexpr double SAFETY = 0.9;
constexpr double MIN_FACTOR = 0.2;
constexpr double MAX_FACTOR = 10;

void gemv_rows(const std::vector<Vec>& K, std::size_t s, const double* a, std::size_t m, double* y) {
    std::size_t m3 = m & 3;
    std::size_t mb = m - m3;
    for (std::size_t i = 0; i < mb; ++i) {
        double acc = 0.0;
        std::size_t j = 0;
        for (; j + 4 <= s; j += 4) {
            double t4 = K[j][i] * a[j];
            double t5 = K[j + 1][i] * a[j + 1];
            t4 = std::fma(K[j + 2][i], a[j + 2], t4);
            t5 = std::fma(K[j + 3][i], a[j + 3], t5);
            acc = acc + (t4 + t5);
        }
        if ((s - j) & 2) {
            acc = acc + (K[j][i] * a[j] + K[j + 1][i] * a[j + 1]);
            j += 2;
        }
        if ((s - j) & 1) acc = acc + K[j][i] * a[j];
        y[i] = acc;
    }
    for (std::size_t i = mb; i < m; ++i) {
        double temp = 0.0;
        std::size_t j = 0;
        if (m == m3) {
            for (; j + 4 <= s; j += 4) {
                if (m3 == 1) {
                    temp = temp + (((K[j][i] * a[j] + K[j + 1][i] * a[j + 1]) + K[j + 2][i] * a[j + 2]) +
                                   K[j + 3][i] * a[j + 3]);
                } else {
                    temp = temp + (K[j][i] * a[j] + K[j + 1][i] * a[j + 1]);
                    temp = temp + (K[j + 2][i] * a[j + 2] + K[j + 3][i] * a[j + 3]);
                }
            }
        }
        for (; j < s; ++j) temp = temp + K[j][i] * a[j];
        y[i] = 0.0 + temp;
    }
}

Vec gemv_rows(const std::vector<Vec>& K, std::size_t s, const double* a, std::size_t m) {
    Vec y(m);
    gemv_rows(K, s, a, m, y.data());
    return y;
}

double rms_norm(const Vec& x) {
    return npnorm(x) / pypow(static_cast<double>(x.size()), 0.5);
}

int find_interval_ascending(const Vec& x, double xval) {
    std::size_t nx = x.size();
    int interval = 0;
    double a = x[0];
    double b = x[nx - 1];
    if (!(a <= xval && xval <= b)) {
        if (xval < a) return 0;
        if (xval > b) return static_cast<int>(nx) - 2;
        return -1;
    }
    if (xval == b) return static_cast<int>(nx) - 2;
    int low, high;
    if (xval >= x[interval]) {
        low = interval;
        high = static_cast<int>(nx) - 2;
    } else {
        low = 0;
        high = interval;
    }
    if (xval < x[low + 1]) high = low;
    while (low < high) {
        int mid = (high + low) / 2;
        if (xval < x[mid]) {
            high = mid;
        } else if (xval >= x[mid + 1]) {
            low = mid + 1;
        } else {
            low = mid;
            break;
        }
    }
    return low;
}

void gtsv(Vec dl, Vec d, Vec du, std::vector<Vec>& b) {
    long n = static_cast<long>(d.size());
    std::size_t nrhs = b.empty() ? 0 : b[0].size();
    auto elim = [&](long i, bool last) {
        if (std::fabs(d[i]) >= std::fabs(dl[i])) {
            if (d[i] == 0.0) throw std::runtime_error("singular matrix");
            double fact = dl[i] / d[i];
            d[i + 1] = d[i + 1] - fact * du[i];
            for (std::size_t j = 0; j < nrhs; ++j) b[i + 1][j] = b[i + 1][j] - fact * b[i][j];
            if (!last) dl[i] = 0.0;
        } else {
            double fact = d[i] / dl[i];
            d[i] = dl[i];
            double temp = d[i + 1];
            d[i + 1] = du[i] - fact * temp;
            if (!last) {
                dl[i] = du[i + 1];
                du[i + 1] = -fact * dl[i];
            }
            du[i] = temp;
            for (std::size_t j = 0; j < nrhs; ++j) {
                double tb = b[i][j];
                b[i][j] = b[i + 1][j];
                b[i + 1][j] = tb - fact * b[i + 1][j];
            }
        }
    };
    for (long i = 0; i < n - 2; ++i) elim(i, false);
    if (n > 1) elim(n - 2, true);
    if (d[n - 1] == 0.0) throw std::runtime_error("singular matrix");
    for (std::size_t j = 0; j < nrhs; ++j) {
        b[n - 1][j] = b[n - 1][j] / d[n - 1];
        if (n > 1) b[n - 2][j] = (b[n - 2][j] - du[n - 2] * b[n - 1][j]) / d[n - 2];
        for (long i = n - 3; i >= 0; --i)
            b[i][j] = (b[i][j] - du[i] * b[i + 1][j] - dl[i] * b[i + 2][j]) / d[i];
    }
}

void gesv3(double A[3][3], std::vector<Vec>& b) {
    std::size_t nrhs = b[0].size();
    int piv[3];
    for (int j = 0; j < 3; ++j) {
        int p = j;
        double best = std::fabs(A[j][j]);
        for (int i = j + 1; i < 3; ++i)
            if (std::fabs(A[i][j]) > best) {
                best = std::fabs(A[i][j]);
                p = i;
            }
        piv[j] = p;
        if (A[p][j] == 0.0) throw std::runtime_error("singular matrix");
        if (p != j)
            for (int k = 0; k < 3; ++k) std::swap(A[j][k], A[p][k]);
        double r = 1.0 / A[j][j];
        for (int i = j + 1; i < 3; ++i) A[i][j] *= r;
        for (int i = j + 1; i < 3; ++i)
            for (int k = j + 1; k < 3; ++k) A[i][k] -= A[i][j] * A[j][k];
    }
    for (int j = 0; j < 3; ++j)
        if (piv[j] != j) std::swap(b[j], b[piv[j]]);
    for (std::size_t c = 0; c < nrhs; ++c) {
        for (int i = 1; i < 3; ++i)
            for (int k = 0; k < i; ++k) b[i][c] -= A[i][k] * b[k][c];
        for (int k = 2; k >= 0; --k) {
            if (nrhs == 1)
                b[k][c] /= A[k][k];
            else
                b[k][c] *= 1.0 / A[k][k];
            for (int i = 0; i < k; ++i) b[i][c] -= A[i][k] * b[k][c];
        }
    }
}

struct Dop853 {
    Rhs fun;
    double t;
    double t_old = 0.0;
    bool has_old = false;
    Vec y;
    Vec y_old;
    Vec f;
    double t_bound;
    double direction;
    std::size_t n;
    double max_step;
    double rtol;
    double atol;
    double h_abs;
    double h_previous = 0.0;
    double error_exponent = -1.0 / (7 + 1);
    std::vector<Vec> K;
    long nfev = 0;
    std::string status = "running";

    Vec call(double tt, const Vec& yy) {
        ++nfev;
        Vec r = fun(tt, yy);
        if (r.size() != n) throw ValueError("fun returned a vector of wrong size");
        return r;
    }

    double select_initial_step() {
        if (n == 0) return INF;
        double interval_length = std::fabs(t_bound - t);
        if (interval_length == 0.0) return 0.0;
        Vec scale(n), tmp(n);
        for (std::size_t i = 0; i < n; ++i) scale[i] = atol + std::fabs(y[i]) * rtol;
        for (std::size_t i = 0; i < n; ++i) tmp[i] = y[i] / scale[i];
        double d0 = rms_norm(tmp);
        for (std::size_t i = 0; i < n; ++i) tmp[i] = f[i] / scale[i];
        double d1 = rms_norm(tmp);
        double h0 = (d0 < 1e-5 || d1 < 1e-5) ? 1e-6 : 0.01 * d0 / d1;
        h0 = std::min(h0, interval_length);
        Vec y1(n);
        double hd = h0 * direction;
        for (std::size_t i = 0; i < n; ++i) y1[i] = y[i] + hd * f[i];
        Vec f1 = call(t + h0 * direction, y1);
        for (std::size_t i = 0; i < n; ++i) tmp[i] = (f1[i] - f[i]) / scale[i];
        double d2 = rms_norm(tmp) / h0;
        double h1;
        if (d1 <= 1e-15 && d2 <= 1e-15) {
            h1 = std::max(1e-6, h0 * 1e-3);
        } else {
            double mx = (d2 > d1) ? d2 : d1;
            h1 = pypow(0.01 / mx, 1.0 / (7 + 1));
        }
        double r = 100 * h0;
        if (h1 < r) r = h1;
        if (interval_length < r) r = interval_length;
        if (max_step < r) r = max_step;
        return r;
    }

    Dop853(const Rhs& fn, double t0, const Vec& y0, double tb, const IvpOptions& o)
        : fun(fn), t(t0), y(y0), t_bound(tb), n(y0.size()) {
        for (double v : y0)
            if (!std::isfinite(v)) throw ValueError("All components of the initial state `y0` must be finite.");
        direction = (t_bound != t0) ? ((t_bound - t0) > 0 ? 1.0 : ((t_bound - t0) < 0 ? -1.0 : 0.0)) : 1.0;
        if (o.max_step <= 0) throw ValueError("`max_step` must be positive.");
        max_step = o.max_step;
        rtol = o.rtol;
        if (rtol < 100 * EPS) rtol = 100 * EPS;
        atol = o.atol;
        if (atol < 0) throw ValueError("`atol` must be positive.");
        f = call(t, y);
        if (!o.first_step) {
            h_abs = select_initial_step();
        } else {
            double fs = *o.first_step;
            if (fs <= 0) throw ValueError("`first_step` must be positive.");
            if (fs > std::fabs(t_bound - t0)) throw ValueError("`first_step` exceeds bounds.");
            h_abs = fs;
        }
        K.assign(N_STAGES_EXTENDED, Vec(n, 0.0));
    }

    void rk_step(double h, Vec& y_new, Vec& f_new) {
        K[0] = f;
        Vec yy(n);
        for (int s = 1; s < N_STAGES; ++s) {
            Vec dy = gemv_rows(K, s, A_ALL[s], n);
            for (std::size_t i = 0; i < n; ++i) yy[i] = y[i] + dy[i] * h;
            K[s] = call(t + C_ALL[s] * h, yy);
        }
        Vec bdot = gemv_rows(K, N_STAGES, A_ALL[N_STAGES], n);
        y_new.resize(n);
        for (std::size_t i = 0; i < n; ++i) y_new[i] = y[i] + h * bdot[i];
        f_new = call(t + h, y_new);
        K[N_STAGES] = f_new;
    }

    double estimate_error_norm(double h, const Vec& scale) {
        Vec err5 = gemv_rows(K, N_STAGES + 1, E5, n);
        Vec err3 = gemv_rows(K, N_STAGES + 1, E3, n);
        for (std::size_t i = 0; i < n; ++i) {
            err5[i] = err5[i] / scale[i];
            err3[i] = err3[i] / scale[i];
        }
        double e5 = pypow(npnorm(err5), 2);
        double e3 = pypow(npnorm(err3), 2);
        if (e5 == 0 && e3 == 0) return 0.0;
        double denom = e5 + 0.01 * e3;
        return std::fabs(h) * e5 / std::sqrt(denom * static_cast<double>(scale.size()));
    }

    bool step_impl(std::string& message) {
        double tt = t;
        double min_step = 10 * std::fabs(std::nextafter(tt, direction * INF) - tt);
        double ha;
        if (h_abs > max_step)
            ha = max_step;
        else if (h_abs < min_step)
            ha = min_step;
        else
            ha = h_abs;
        bool step_accepted = false;
        bool step_rejected = false;
        double h = 0.0, t_new = 0.0;
        Vec y_new, f_new;
        Vec scale(n);
        while (!step_accepted) {
            if (ha < min_step) {
                message = "Required step size is less than spacing between numbers.";
                return false;
            }
            h = ha * direction;
            t_new = tt + h;
            if (direction * (t_new - t_bound) > 0) t_new = t_bound;
            h = t_new - tt;
            ha = std::fabs(h);
            rk_step(h, y_new, f_new);
            for (std::size_t i = 0; i < n; ++i)
                scale[i] = atol + std::max(std::fabs(y[i]), std::fabs(y_new[i])) * rtol;
            double error_norm = estimate_error_norm(h, scale);
            if (error_norm < 1) {
                double factor;
                if (error_norm == 0)
                    factor = MAX_FACTOR;
                else
                    factor = std::min<double>(MAX_FACTOR, SAFETY * pypow(error_norm, error_exponent));
                if (step_rejected) factor = std::min(1.0, factor);
                ha *= factor;
                step_accepted = true;
            } else {
                ha *= std::max(MIN_FACTOR, SAFETY * pypow(error_norm, error_exponent));
                step_rejected = true;
            }
        }
        h_previous = h;
        y_old = y;
        t = t_new;
        y = y_new;
        h_abs = ha;
        f = f_new;
        return true;
    }

    std::string step() {
        std::string message;
        if (n == 0 || t == t_bound) {
            t_old = t;
            has_old = true;
            t = t_bound;
            status = "finished";
            return message;
        }
        double tt = t;
        if (!step_impl(message)) {
            status = "failed";
        } else {
            t_old = tt;
            has_old = true;
            if (direction * (t - t_bound) >= 0) status = "finished";
        }
        return message;
    }

    DenseSegment dense_output() {
        DenseSegment seg;
        seg.t_old = t_old;
        seg.t = t;
        seg.h = t - t_old;
        if (n == 0 || t == t_old) {
            seg.constant = true;
            seg.y_old = y;
            return seg;
        }
        double h = h_previous;
        Vec yy(n);
        for (int s = N_STAGES + 1; s < N_STAGES_EXTENDED; ++s) {
            Vec dy = gemv_rows(K, s, A_ALL[s], n);
            for (std::size_t i = 0; i < n; ++i) yy[i] = y_old[i] + dy[i] * h;
            K[s] = call(t_old + C_ALL[s] * h, yy);
        }
        seg.F.assign(INTERPOLATOR_POWER, Vec(n));
        const Vec& f_old = K[0];
        for (std::size_t i = 0; i < n; ++i) {
            double delta_y = y[i] - y_old[i];
            seg.F[0][i] = delta_y;
            seg.F[1][i] = h * f_old[i] - delta_y;
            seg.F[2][i] = 2 * delta_y - h * (f[i] + f_old[i]);
        }
        for (int r = 0; r < INTERPOLATOR_POWER - 3; ++r)
            for (std::size_t i = 0; i < n; ++i) {
                double acc = 0.0;
                for (int k = 0; k < N_STAGES_EXTENDED; ++k) acc = std::fma(D_INT[r][k], K[k][i], acc);
                seg.F[3 + r][i] = h * acc;
            }
        seg.y_old = y_old;
        return seg;
    }
};

}

Vec gemv_n(const std::vector<Vec>& K, std::size_t s, const double* a, std::size_t m) { return gemv_rows(K, s, a, m); }

double gemv_t_dot(const double* a, std::size_t stride, const double* x, std::size_t len, std::size_t col, std::size_t ncols) {
    std::size_t m3 = len & 3;
    std::size_t mb = len - m3;
    double y = 0.0;
    if (mb > 0) {
        bool single = (ncols & 1) && col == ncols - 1;
        double l0 = 0.0, l1 = 0.0, k0 = 0.0, k1 = 0.0;
        for (std::size_t i = 0; i < mb; i += 4) {
            if (single) {
                l0 = l0 + a[i * stride] * x[i];
                l1 = l1 + a[(i + 1) * stride] * x[i + 1];
                k0 = k0 + a[(i + 2) * stride] * x[i + 2];
                k1 = k1 + a[(i + 3) * stride] * x[i + 3];
            } else {
                l0 = l0 + a[i * stride] * x[i];
                l1 = l1 + a[(i + 1) * stride] * x[i + 1];
                l0 = l0 + a[(i + 2) * stride] * x[i + 2];
                l1 = l1 + a[(i + 3) * stride] * x[i + 3];
            }
        }
        if (single) {
            l0 = l0 + k0;
            l1 = l1 + k1;
        }
        y = y + (l0 + l1);
    }
    const double* t = a + mb * stride;
    const double* u = x + mb;
    if (m3 == 1) y = std::fma(t[0], u[0], y);
    else if (m3 == 2) y = y + std::fma(t[0], u[0], t[stride] * u[1]);
    else if (m3 == 3) y = y + std::fma(t[2 * stride], u[2], std::fma(t[0], u[0], t[stride] * u[1]));
    return y;
}

double pypow(double a, double b) { return pow_ptr(a, b); }

double npdot(const double* a, const double* b, std::size_t n) {
    double s = 0.0;
    for (std::size_t i = 0; i < n; ++i) s = s + a[i] * b[i];
    return s;
}

double npdot(const Vec& a, const Vec& b) { return npdot(a.data(), b.data(), a.size()); }

double npnorm(const double* v, std::size_t n) { return std::sqrt(npdot(v, v, n)); }

double npnorm(const Vec& v) { return npnorm(v.data(), v.size()); }

std::array<double, 6> matvec6(const double (&m)[6][6], const double* x) {
    std::array<double, 6> y{};
    for (int j = 0; j < 6; ++j) {
        const double* a = m[j];
        double t = (a[0] * x[0] + a[2] * x[2]) + (a[1] * x[1] + a[3] * x[3]);
        y[j] = t + std::fma(a[4], x[4], a[5] * x[5]);
    }
    return y;
}

Vec linspace(double start, double stop, long num) {
    if (num < 0) throw ValueError("Number of samples must be non-negative.");
    Vec y(static_cast<std::size_t>(num));
    long div = num - 1;
    double delta = stop - start;
    for (long i = 0; i < num; ++i) y[i] = static_cast<double>(i);
    if (div > 0) {
        double step = delta / static_cast<double>(div);
        if (step == 0) {
            for (auto& v : y) v = (v / static_cast<double>(div)) * delta;
        } else {
            for (auto& v : y) v = v * step;
        }
    } else {
        for (auto& v : y) v = v * delta;
    }
    for (auto& v : y) v = v + start;
    if (num > 1) y[num - 1] = stop;
    return y;
}

double brentq(const std::function<double(double)>& fn, double xa, double xb, double xtol, double rtol,
              int iter) {
    if (xtol <= 0) throw ValueError("xtol too small");
    if (rtol < 4 * EPS) throw ValueError("rtol too small");
    auto f = [&](double x) {
        double v = fn(x);
        if (std::isnan(v)) throw ValueError("The function value is NaN; solver cannot continue.");
        return v;
    };
    double xpre = xa, xcur = xb;
    double xblk = 0., fpre, fcur, fblk = 0., spre = 0., scur = 0., sbis;
    double delta;
    double stry, dpre, dblk;
    fpre = f(xpre);
    fcur = f(xcur);
    if (fpre == 0) return xpre;
    if (fcur == 0) return xcur;
    if (std::signbit(fpre) == std::signbit(fcur)) throw ValueError("f(a) and f(b) must have different signs");
    for (int i = 0; i < iter; i++) {
        if (fpre != 0 && fcur != 0 && (std::signbit(fpre) != std::signbit(fcur))) {
            xblk = xpre;
            fblk = fpre;
            spre = scur = xcur - xpre;
        }
        if (std::fabs(fblk) < std::fabs(fcur)) {
            xpre = xcur;
            xcur = xblk;
            xblk = xpre;
            fpre = fcur;
            fcur = fblk;
            fblk = fpre;
        }
        delta = (xtol + rtol * std::fabs(xcur)) / 2;
        sbis = (xblk - xcur) / 2;
        if (fcur == 0 || std::fabs(sbis) < delta) return xcur;
        if (std::fabs(spre) > delta && std::fabs(fcur) < std::fabs(fpre)) {
            if (xpre == xblk) {
                stry = -fcur * (xcur - xpre) / (fcur - fpre);
            } else {
                dpre = (fpre - fcur) / (xpre - xcur);
                dblk = (fblk - fcur) / (xblk - xcur);
                stry = -fcur * (fblk * dblk - fpre * dpre) / (dblk * dpre * (fblk - fpre));
            }
            if (2 * std::fabs(stry) < std::min(std::fabs(spre), 3 * std::fabs(sbis) - delta)) {
                spre = scur;
                scur = stry;
            } else {
                spre = sbis;
                scur = sbis;
            }
        } else {
            spre = sbis;
            scur = sbis;
        }
        xpre = xcur;
        fpre = fcur;
        if (std::fabs(scur) > delta)
            xcur += scur;
        else
            xcur += (sbis > 0 ? delta : -delta);
        fcur = f(xcur);
    }
    throw std::runtime_error("Failed to converge after " + std::to_string(iter) + " iterations.");
}

CubicSpline::CubicSpline(const Vec& x, const std::vector<Vec>& y) : x_(x) {
    std::size_t n = x.size();
    if (n < 2) throw ValueError("`x` must contain at least 2 elements.");
    if (y.size() != n) throw ValueError("The length of `y` doesn't match the length of `x`");
    std::size_t m = y[0].size();
    for (double v : x)
        if (!std::isfinite(v)) throw ValueError("`x` must contain only finite values.");
    for (const auto& r : y) {
        if (r.size() != m) throw ValueError("`y` rows must have equal length.");
        for (double v : r)
            if (!std::isfinite(v)) throw ValueError("`y` must contain only finite values.");
    }
    Vec dx(n - 1);
    for (std::size_t i = 0; i + 1 < n; ++i) {
        dx[i] = x[i + 1] - x[i];
        if (dx[i] <= 0) throw ValueError("`x` must be strictly increasing sequence.");
    }
    std::vector<Vec> slope(n - 1, Vec(m));
    for (std::size_t i = 0; i + 1 < n; ++i)
        for (std::size_t j = 0; j < m; ++j) slope[i][j] = (y[i + 1][j] - y[i][j]) / dx[i];
    std::vector<Vec> s(n, Vec(m));
    if (n == 2) {
        s[0] = slope[0];
        s[1] = slope[0];
    } else if (n == 3) {
        double A[3][3] = {{1, 1, 0}, {dx[1], 2 * (dx[0] + dx[1]), dx[0]}, {0, 1, 1}};
        for (std::size_t j = 0; j < m; ++j) {
            s[0][j] = 2 * slope[0][j];
            s[1][j] = 3 * (dx[0] * slope[1][j] + dx[1] * slope[0][j]);
            s[2][j] = 2 * slope[1][j];
        }
        gesv3(A, s);
    } else {
        Vec du(n - 1), d(n), dl(n - 1);
        for (std::size_t i = 1; i + 1 < n; ++i) d[i] = 2 * (dx[i - 1] + dx[i]);
        for (std::size_t i = 1; i + 1 < n; ++i) du[i] = dx[i - 1];
        for (std::size_t i = 0; i + 2 < n; ++i) dl[i] = dx[i + 1];
        for (std::size_t i = 1; i + 1 < n; ++i)
            for (std::size_t j = 0; j < m; ++j)
                s[i][j] = 3 * (dx[i] * slope[i - 1][j] + dx[i - 1] * slope[i][j]);
        d[0] = dx[1];
        du[0] = x[2] - x[0];
        double d0 = x[2] - x[0];
        for (std::size_t j = 0; j < m; ++j)
            s[0][j] = ((dx[0] + 2 * d0) * dx[1] * slope[0][j] + (dx[0] * dx[0]) * slope[1][j]) / d0;
        d[n - 1] = dx[n - 3];
        dl[n - 2] = x[n - 1] - x[n - 3];
        double d1 = x[n - 1] - x[n - 3];
        for (std::size_t j = 0; j < m; ++j)
            s[n - 1][j] = ((dx[n - 2] * dx[n - 2]) * slope[n - 3][j] + (2 * d1 + dx[n - 2]) * dx[n - 3] * slope[n - 2][j]) / d1;
        gtsv(dl, d, du, s);
    }
    c_.resize(n - 1);
    for (std::size_t i = 0; i + 1 < n; ++i) {
        for (auto& c : c_[i]) c.resize(m);
        for (std::size_t j = 0; j < m; ++j) {
            double t = (s[i][j] + s[i + 1][j] - 2 * slope[i][j]) / dx[i];
            c_[i][0][j] = t / dx[i];
            c_[i][1][j] = (slope[i][j] - s[i][j]) / dx[i] - t;
            c_[i][2][j] = s[i][j];
            c_[i][3][j] = y[i][j];
        }
    }
}

Vec CubicSpline::operator()(double t) const {
    std::size_t m = c_[0][0].size();
    Vec out(m);
    int interval = find_interval_ascending(x_, t);
    if (interval < 0) {
        for (auto& v : out) v = std::nan("");
        return out;
    }
    double sv = t - x_[interval];
    const auto& c = c_[interval];
    for (std::size_t j = 0; j < m; ++j) {
        double res = 0.0;
        double z = 1.0;
        for (int kp = 0; kp < 4; ++kp) {
            res = res + c[3 - kp][j] * z * 1.0;
            if (kp < 3) z *= sv;
        }
        out[j] = res;
    }
    return out;
}

ScalarMinResult minimize_scalar_bounded(const std::function<double(double)>& func, double x1, double x2,
                                        double xatol, int maxiter) {
    int maxfun = maxiter;
    if (!(std::isfinite(x1) && std::isfinite(x2))) throw ValueError("Optimization bounds must be finite scalars.");
    if (x1 > x2) throw ValueError("The lower bound exceeds the upper bound.");
    int flag = 0;
    double sqrt_eps = std::sqrt(2.2e-16);
    double golden_mean = 0.5 * (3.0 - std::sqrt(5.0));
    double a = x1, b = x2;
    double fulc = a + golden_mean * (b - a);
    double nfc = fulc, xf = fulc;
    double rat = 0.0, e = 0.0;
    double x = xf;
    double fx = func(x);
    int num = 1;
    double fu = INF;
    double ffulc = fx, fnfc = fx;
    double xm = 0.5 * (a + b);
    double tol1 = sqrt_eps * std::fabs(xf) + xatol / 3.0;
    double tol2 = 2.0 * tol1;
    auto sign = [](double v) { return v > 0 ? 1.0 : (v < 0 ? -1.0 : (v == 0 ? 0.0 : v)); };
    while (std::fabs(xf - xm) > (tol2 - 0.5 * (b - a))) {
        int golden = 1;
        if (std::fabs(e) > tol1) {
            golden = 0;
            double r = (xf - nfc) * (fx - ffulc);
            double q = (xf - fulc) * (fx - fnfc);
            double p = (xf - fulc) * q - (xf - nfc) * r;
            q = 2.0 * (q - r);
            if (q > 0.0) p = -p;
            q = std::fabs(q);
            r = e;
            e = rat;
            if ((std::fabs(p) < std::fabs(0.5 * q * r)) && (p > q * (a - xf)) && (p < q * (b - xf))) {
                rat = (p + 0.0) / q;
                x = xf + rat;
                if (((x - a) < tol2) || ((b - x) < tol2)) {
                    double si = sign(xm - xf) + ((xm - xf) == 0 ? 1.0 : 0.0);
                    rat = tol1 * si;
                }
            } else {
                golden = 1;
            }
        }
        if (golden) {
            if (xf >= xm)
                e = a - xf;
            else
                e = b - xf;
            rat = golden_mean * e;
        }
        double si = sign(rat) + (rat == 0 ? 1.0 : 0.0);
        double ar = std::fabs(rat);
        double mx = (std::isnan(ar) || std::isnan(tol1)) ? std::nan("") : std::max(ar, tol1);
        x = xf + si * mx;
        fu = func(x);
        num += 1;
        if (fu <= fx) {
            if (x >= xf)
                a = xf;
            else
                b = xf;
            fulc = nfc;
            ffulc = fnfc;
            nfc = xf;
            fnfc = fx;
            xf = x;
            fx = fu;
        } else {
            if (x < xf)
                a = x;
            else
                b = x;
            if ((fu <= fnfc) || (nfc == xf)) {
                fulc = nfc;
                ffulc = fnfc;
                nfc = x;
                fnfc = fu;
            } else if ((fu <= ffulc) || (fulc == xf) || (fulc == nfc)) {
                fulc = x;
                ffulc = fu;
            }
        }
        xm = 0.5 * (a + b);
        tol1 = sqrt_eps * std::fabs(xf) + xatol / 3.0;
        tol2 = 2.0 * tol1;
        if (num >= maxfun) {
            flag = 1;
            break;
        }
    }
    if (std::isnan(xf) || std::isnan(fx) || std::isnan(fu)) flag = 2;
    return {xf, fx, flag == 0, flag, num};
}

Vec DenseSegment::operator()(double tt) const {
    if (constant) return y_old;
    double x = (tt - t_old) / h;
    std::size_t n = y_old.size();
    Vec y(n, 0.0);
    for (int i = 0; i < static_cast<int>(F.size()); ++i) {
        const Vec& fr = F[F.size() - 1 - i];
        for (std::size_t k = 0; k < n; ++k) y[k] += fr[k];
        double mul = (i % 2 == 0) ? x : 1 - x;
        for (std::size_t k = 0; k < n; ++k) y[k] *= mul;
    }
    for (std::size_t k = 0; k < n; ++k) y[k] += y_old[k];
    return y;
}

OdeSolution::OdeSolution(Vec ts, std::vector<DenseSegment> segments)
    : ts_(std::move(ts)), segments_(std::move(segments)) {
    if (ts_.size() != segments_.size() + 1) throw ValueError("Numbers of time stamps and interpolants don't match.");
    if (ts_.back() >= ts_.front()) {
        t_min_ = ts_.front();
        t_max_ = ts_.back();
        ascending_ = true;
        ts_sorted_ = ts_;
    } else {
        t_min_ = ts_.back();
        t_max_ = ts_.front();
        ascending_ = false;
        ts_sorted_.assign(ts_.rbegin(), ts_.rend());
    }
}

Vec OdeSolution::operator()(double t) const {
    long ind;
    if (ascending_)
        ind = std::lower_bound(ts_sorted_.begin(), ts_sorted_.end(), t) - ts_sorted_.begin();
    else
        ind = std::upper_bound(ts_sorted_.begin(), ts_sorted_.end(), t) - ts_sorted_.begin();
    long nseg = static_cast<long>(segments_.size());
    long segment = std::min(std::max(ind - 1, 0L), nseg - 1);
    if (!ascending_) segment = nseg - 1 - segment;
    return segments_[segment](t);
}

IvpResult solve_ivp_dop853(const Rhs& fun, double t0, double tf, const Vec& y0, const IvpOptions& options,
                           const std::vector<Event>& events) {
    Dop853 solver(fun, t0, y0, tf, options);
    IvpResult res;
    Vec ts{t0};
    std::vector<Vec> ys{y0};
    std::vector<DenseSegment> interpolants;
    std::size_t ne = events.size();
    Vec max_events(ne), event_dir(ne), event_count(ne, 0.0), g(ne);
    for (std::size_t i = 0; i < ne; ++i) {
        max_events[i] = events[i].terminal ? 1.0 : INF;
        event_dir[i] = events[i].direction;
    }
    for (std::size_t i = 0; i < ne; ++i) g[i] = events[i].g(t0, y0);
    res.t_events.assign(ne, Vec());
    res.y_events.assign(ne, std::vector<Vec>());
    int status = 0;
    bool have_status = false;
    std::string message;
    while (!have_status) {
        message = solver.step();
        if (solver.status == "finished") {
            status = 0;
            have_status = true;
        } else if (solver.status == "failed") {
            status = -1;
            have_status = true;
            break;
        }
        double t_old = solver.t_old;
        double t = solver.t;
        Vec y = solver.y;
        std::optional<DenseSegment> sol;
        if (options.dense_output) {
            sol = solver.dense_output();
            interpolants.push_back(*sol);
        }
        if (ne > 0) {
            Vec g_new(ne);
            for (std::size_t i = 0; i < ne; ++i) g_new[i] = events[i].g(t, y);
            std::vector<std::size_t> active;
            for (std::size_t i = 0; i < ne; ++i) {
                bool up = (g[i] <= 0) && (g_new[i] >= 0);
                bool down = (g[i] >= 0) && (g_new[i] <= 0);
                bool either = up || down;
                if ((up && event_dir[i] > 0) || (down && event_dir[i] < 0) || (either && event_dir[i] == 0))
                    active.push_back(i);
            }
            if (!active.empty()) {
                if (!sol) sol = solver.dense_output();
                for (std::size_t e : active) event_count[e] += 1;
                Vec roots;
                for (std::size_t e : active) {
                    const DenseSegment& seg = *sol;
                    const Event& ev = events[e];
                    roots.push_back(brentq([&](double tt) { return ev.g(tt, seg(tt)); }, t_old, t, 4 * EPS, 4 * EPS));
                }
                bool terminate = false;
                bool any = false;
                for (std::size_t e : active)
                    if (event_count[e] >= max_events[e]) any = true;
                if (any) {
                    std::vector<std::size_t> order(active.size());
                    std::iota(order.begin(), order.end(), 0);
                    if (t > t_old)
                        std::stable_sort(order.begin(), order.end(),
                                         [&](std::size_t a, std::size_t b) { return roots[a] < roots[b]; });
                    else
                        std::stable_sort(order.begin(), order.end(),
                                         [&](std::size_t a, std::size_t b) { return -roots[a] < -roots[b]; });
                    std::vector<std::size_t> act2;
                    Vec roots2;
                    for (std::size_t k : order) {
                        act2.push_back(active[k]);
                        roots2.push_back(roots[k]);
                    }
                    std::size_t cut = 0;
                    for (std::size_t k = 0; k < act2.size(); ++k)
                        if (event_count[act2[k]] >= max_events[act2[k]]) {
                            cut = k;
                            break;
                        }
                    act2.resize(cut + 1);
                    roots2.resize(cut + 1);
                    active = act2;
                    roots = roots2;
                    terminate = true;
                }
                for (std::size_t k = 0; k < active.size(); ++k) {
                    res.t_events[active[k]].push_back(roots[k]);
                    res.y_events[active[k]].push_back((*sol)(roots[k]));
                }
                if (terminate) {
                    status = 1;
                    have_status = true;
                    t = roots.back();
                    y = (*sol)(t);
                }
            }
            g = g_new;
        }
        bool donot_append = ts.size() > 1 && ts.back() == t && options.dense_output;
        if (!donot_append) {
            ts.push_back(t);
            ys.push_back(y);
        } else if (!interpolants.empty()) {
            interpolants.pop_back();
        }
    }
    if (status == 0)
        res.message = "The solver successfully reached the end of the integration interval.";
    else if (status == 1)
        res.message = "A termination event occurred.";
    else
        res.message = message;
    res.status = status;
    res.success = status >= 0;
    res.t = ts;
    res.y = ys;
    if (options.dense_output) res.sol = OdeSolution(ts, interpolants);
    res.nfev = solver.nfev;
    return res;
}

}
