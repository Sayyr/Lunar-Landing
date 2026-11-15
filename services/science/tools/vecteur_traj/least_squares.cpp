#include "least_squares.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace selene::vt {

namespace {

using Mat = std::vector<Vec>;

Vec matvec(const Mat& A, const Vec& x) {
    Vec y(A.size());
    for (std::size_t i = 0; i < A.size(); ++i) y[i] = npdot(A[i].data(), x.data(), x.size());
    return y;
}

Vec jvec(const Mat& J, const Vec& x) {
    Vec y(J.size());
    for (std::size_t i = 0; i < J.size(); ++i) y[i] = gemv_t_dot(J[i].data(), 1, x.data(), x.size(), i, J.size());
    return y;
}

Vec jtvec(const Mat& J, const Vec& x) {
    std::size_t n = J.empty() ? 0 : J[0].size();
    Vec y(n), col(J.size());
    for (std::size_t j = 0; j < n; ++j) {
        for (std::size_t i = 0; i < J.size(); ++i) col[i] = J[i][j];
        y[j] = gemv_t_dot(col.data(), 1, x.data(), J.size(), j, n);
    }
    return y;
}

double norm_inf(const Vec& v) {
    double m = 0.0;
    for (double x : v) {
        double a = std::fabs(x);
        if (std::isnan(a)) return a;
        if (a > m) m = a;
    }
    return m;
}

double sign_of(double v) { return v > 0 ? 1.0 : (v < 0 ? -1.0 : v); }

double py_max(double a, double b) { return b > a ? b : a; }

double py_min(double a, double b) { return b < a ? b : a; }

struct CM {
    double* p;
    int ld;
    double& operator()(int i, int j) const { return p[(i - 1) + static_cast<std::size_t>(j - 1) * ld]; }
    double* at(int i, int j) const { return &(*this)(i, j); }
};

double f_sign(double a, double b) { return std::copysign(std::fabs(a), b); }

double b_nrm2(int n, const double* x, int inc) {
    if (n <= 0) return 0.0;
    long double s = 0.0L;
    for (int i = 0; i < n; ++i) {
        long double v = x[static_cast<std::ptrdiff_t>(i) * inc];
        s += v * v;
    }
    return static_cast<double>(std::sqrt(s));
}

void b_scal(int n, double a, double* x, int inc) {
    for (int i = 0; i < n; ++i) x[static_cast<std::ptrdiff_t>(i) * inc] *= a;
}

void b_ger(int m, int n, double alpha, const double* x, int incx, const double* y, int incy, double* A, int lda) {
    if (m <= 0 || n <= 0 || alpha == 0.0) return;
    for (int j = 0; j < n; ++j) {
        double t = alpha * y[static_cast<std::ptrdiff_t>(j) * incy];
        for (int i = 0; i < m; ++i) {
            double& a = A[i + static_cast<std::size_t>(j) * lda];
            a = a + x[static_cast<std::ptrdiff_t>(i) * incx] * t;
        }
    }
}

void b_gemv_t(int m, int n, const double* A, int lda, const double* x, int incx, double* y) {
    if (m <= 0 || n <= 0) return;
    Vec xb(m);
    for (int i = 0; i < m; ++i) xb[i] = x[static_cast<std::ptrdiff_t>(i) * incx];
    for (int j = 0; j < n; ++j)
        y[j] = gemv_t_dot(A + static_cast<std::size_t>(j) * lda, 1, xb.data(), m, j, n);
}

void b_gemv_n(int m, int n, const double* A, int lda, const double* x, int incx, double* y) {
    if (m <= 0 || n <= 0) return;
    std::vector<Vec> K(n, Vec(m));
    Vec xb(n);
    for (int j = 0; j < n; ++j) {
        xb[j] = x[static_cast<std::ptrdiff_t>(j) * incx];
        for (int i = 0; i < m; ++i) K[j][i] = A[i + static_cast<std::size_t>(j) * lda];
    }
    Vec r = gemv_n(K, n, xb.data(), m);
    for (int i = 0; i < m; ++i) y[i] = r[i];
}

void b_rot(int n, double* x, int incx, double* y, int incy, double c, double s) {
    for (int i = 0; i < n; ++i) {
        double& xi = x[static_cast<std::ptrdiff_t>(i) * incx];
        double& yi = y[static_cast<std::ptrdiff_t>(i) * incy];
        double xv = xi, yv = yi;
        xi = std::fma(c, xv, s * yv);
        yi = std::fma(c, yv, -(s * xv));
    }
}

void b_swap(int n, double* x, int incx, double* y, int incy) {
    for (int i = 0; i < n; ++i) std::swap(x[static_cast<std::ptrdiff_t>(i) * incx], y[static_cast<std::ptrdiff_t>(i) * incy]);
}

int iladlc(int m, int n, const CM& A) {
    if (n == 0) return n;
    if (A(1, n) != 0.0 || A(m, n) != 0.0) return n;
    for (int j = n; j >= 1; --j)
        for (int i = 1; i <= m; ++i)
            if (A(i, j) != 0.0) return j;
    return 0;
}

int iladlr(int m, int n, const CM& A) {
    if (m == 0) return m;
    if (A(m, 1) != 0.0 || A(m, n) != 0.0) return m;
    int r = 0;
    for (int j = 1; j <= n; ++j) {
        int i = m;
        while (i >= 1 && A(std::max(i, 1), j) == 0.0) --i;
        r = std::max(r, i);
    }
    return r;
}

void dlarf(bool left, int m, int n, const double* v, int incv, double tau, const CM& C, double* work) {
    int lastv = 0, lastc = 0;
    if (tau != 0.0) {
        lastv = left ? m : n;
        int i = incv > 0 ? 1 + (lastv - 1) * incv : 1;
        while (lastv > 0 && v[i - 1] == 0.0) {
            --lastv;
            i -= incv;
        }
        lastc = left ? iladlc(lastv, n, C) : iladlr(m, lastv, C);
    }
    if (left) {
        if (lastv > 0) {
            b_gemv_t(lastv, lastc, C.at(1, 1), C.ld, v, incv, work);
            b_ger(lastv, lastc, -tau, v, incv, work, 1, C.at(1, 1), C.ld);
        }
    } else {
        if (lastv > 0) {
            b_gemv_n(lastc, lastv, C.at(1, 1), C.ld, v, incv, work);
            b_ger(lastc, lastv, -tau, work, 1, v, incv, C.at(1, 1), C.ld);
        }
    }
}

void apply_reflector(bool left, int m, int n, double* v, int incv, double tau, const CM& C, double* work) {
    double v0 = v[0];
    v[0] = 1.0;
    dlarf(left, m, n, v, incv, tau, C, work);
    v[0] = v0;
}

double dlapy2(double x, double y) {
    if (std::isnan(x)) return x;
    if (std::isnan(y)) return y;
    double xa = std::fabs(x), ya = std::fabs(y);
    double w = std::max(xa, ya), z = std::min(xa, ya);
    if (z == 0.0 || w > std::numeric_limits<double>::max()) return w;
    double q = z / w;
    return w * std::sqrt(1.0 + q * q);
}

void dlarfg(int n, double& alpha, double* x, int incx, double& tau) {
    if (n <= 1) {
        tau = 0.0;
        return;
    }
    double xnorm = b_nrm2(n - 1, x, incx);
    if (xnorm == 0.0) {
        tau = 0.0;
        return;
    }
    double beta = -f_sign(dlapy2(alpha, xnorm), alpha);
    const double safmin = std::numeric_limits<double>::min() / (EPS * 0.5);
    int knt = 0;
    if (std::fabs(beta) < safmin) {
        double rsafmn = 1.0 / safmin;
        do {
            ++knt;
            b_scal(n - 1, rsafmn, x, incx);
            beta *= rsafmn;
            alpha *= rsafmn;
        } while (std::fabs(beta) < safmin && knt < 20);
        xnorm = b_nrm2(n - 1, x, incx);
        beta = -f_sign(dlapy2(alpha, xnorm), alpha);
    }
    tau = (beta - alpha) / beta;
    b_scal(n - 1, 1.0 / (alpha - beta), x, incx);
    for (int j = 0; j < knt; ++j) beta *= safmin;
    alpha = beta;
}

void dlartg(double f, double g, double& c, double& s, double& r) {
    const double safmin = std::numeric_limits<double>::min();
    const double safmax = 1.0 / safmin;
    const double rtmin = std::sqrt(safmin);
    const double rtmax = std::sqrt(safmax / 2);
    double f1 = std::fabs(f), g1 = std::fabs(g);
    if (g == 0.0) {
        c = 1.0;
        s = 0.0;
        r = f;
    } else if (f == 0.0) {
        c = 0.0;
        s = f_sign(1.0, g);
        r = g1;
    } else if (f1 > rtmin && f1 < rtmax && g1 > rtmin && g1 < rtmax) {
        double d = std::sqrt(f * f + g * g);
        c = f1 / d;
        r = f_sign(d, f);
        s = g / r;
    } else {
        double u = std::min(safmax, std::max(safmin, std::max(f1, g1)));
        double fs = f / u, gs = g / u;
        double d = std::sqrt(fs * fs + gs * gs);
        c = std::fabs(fs) / d;
        r = f_sign(d, f);
        s = gs / r;
        r = r * u;
    }
}

void dlas2(double f, double g, double h, double& ssmin, double& ssmax) {
    double fa = std::fabs(f), ga = std::fabs(g), ha = std::fabs(h);
    double fhmn = std::min(fa, ha), fhmx = std::max(fa, ha);
    if (fhmn == 0.0) {
        ssmin = 0.0;
        if (fhmx == 0.0) {
            ssmax = ga;
        } else {
            double q = std::min(fhmx, ga) / std::max(fhmx, ga);
            ssmax = std::max(fhmx, ga) * std::sqrt(1.0 + q * q);
        }
    } else if (ga < fhmx) {
        double as = 1.0 + fhmn / fhmx;
        double at = (fhmx - fhmn) / fhmx;
        double au = (ga / fhmx) * (ga / fhmx);
        double c = 2.0 / (std::sqrt(as * as + au) + std::sqrt(at * at + au));
        ssmin = fhmn * c;
        ssmax = fhmx / c;
    } else {
        double au = fhmx / ga;
        if (au == 0.0) {
            ssmin = (fhmn * fhmx) / ga;
            ssmax = ga;
        } else {
            double as = 1.0 + fhmn / fhmx;
            double at = (fhmx - fhmn) / fhmx;
            double p = as * au, q = at * au;
            double c = 1.0 / (std::sqrt(1.0 + p * p) + std::sqrt(1.0 + q * q));
            ssmin = (fhmn * c) * au;
            ssmin = ssmin + ssmin;
            ssmax = ga / (c + c);
        }
    }
}

void dlasv2(double f, double g, double h, double& ssmin, double& ssmax, double& snr, double& csr, double& snl,
            double& csl) {
    double ft = f, fa = std::fabs(ft), ht = h, ha = std::fabs(h);
    int pmax = 1;
    bool swap = ha > fa;
    if (swap) {
        pmax = 3;
        std::swap(ft, ht);
        std::swap(fa, ha);
    }
    double gt = g, ga = std::fabs(gt);
    double clt, crt, slt, srt;
    if (ga == 0.0) {
        ssmin = ha;
        ssmax = fa;
        clt = 1.0;
        crt = 1.0;
        slt = 0.0;
        srt = 0.0;
    } else {
        bool gasmal = true;
        if (ga > fa) {
            pmax = 2;
            if ((fa / ga) < EPS * 0.5) {
                gasmal = false;
                ssmax = ga;
                if (ha > 1.0)
                    ssmin = fa / (ga / ha);
                else
                    ssmin = (fa / ga) * ha;
                clt = 1.0;
                slt = ht / gt;
                srt = 1.0;
                crt = ft / gt;
            }
        }
        if (gasmal) {
            double d = fa - ha;
            double l = (d == fa) ? 1.0 : d / fa;
            double m = gt / ft;
            double t = 2.0 - l;
            double mm = m * m;
            double tt = t * t;
            double s = std::sqrt(tt + mm);
            double r = (l == 0.0) ? std::fabs(m) : std::sqrt(l * l + mm);
            double a = 0.5 * (s + r);
            ssmin = ha / a;
            ssmax = fa * a;
            if (mm == 0.0) {
                if (l == 0.0)
                    t = f_sign(2.0, ft) * f_sign(1.0, gt);
                else
                    t = gt / f_sign(d, ft) + m / t;
            } else {
                t = (m / (s + t) + m / (r + l)) * (1.0 + a);
            }
            l = std::sqrt(t * t + 4.0);
            crt = 2.0 / l;
            srt = t / l;
            clt = (crt + srt * m) / a;
            slt = ((ht / ft) * srt) / a;
        }
    }
    if (swap) {
        csl = srt;
        snl = crt;
        csr = slt;
        snr = clt;
    } else {
        csl = clt;
        snl = slt;
        csr = crt;
        snr = srt;
    }
    double tsign = 1.0;
    if (pmax == 1) tsign = f_sign(1.0, csr) * f_sign(1.0, csl) * f_sign(1.0, f);
    if (pmax == 2) tsign = f_sign(1.0, snr) * f_sign(1.0, csl) * f_sign(1.0, g);
    if (pmax == 3) tsign = f_sign(1.0, snr) * f_sign(1.0, snl) * f_sign(1.0, h);
    ssmax = f_sign(ssmax, tsign);
    ssmin = f_sign(ssmin, tsign * f_sign(1.0, f) * f_sign(1.0, h));
}

void dlasr_lvf(int m, int n, const double* c, const double* s, const CM& A) {
    for (int j = 1; j <= m - 1; ++j) {
        double ct = c[j - 1], st = s[j - 1];
        if (ct != 1.0 || st != 0.0)
            for (int i = 1; i <= n; ++i) {
                double temp = A(j + 1, i);
                A(j + 1, i) = ct * temp - st * A(j, i);
                A(j, i) = st * temp + ct * A(j, i);
            }
    }
}

void dlasr_lvb(int m, int n, const double* c, const double* s, const CM& A) {
    for (int j = m - 1; j >= 1; --j) {
        double ct = c[j - 1], st = s[j - 1];
        if (ct != 1.0 || st != 0.0)
            for (int i = 1; i <= n; ++i) {
                double temp = A(j + 1, i);
                A(j + 1, i) = ct * temp - st * A(j, i);
                A(j, i) = st * temp + ct * A(j, i);
            }
    }
}

void dlasr_rvf(int m, int n, const double* c, const double* s, const CM& A) {
    for (int j = 1; j <= n - 1; ++j) {
        double ct = c[j - 1], st = s[j - 1];
        if (ct != 1.0 || st != 0.0)
            for (int i = 1; i <= m; ++i) {
                double temp = A(i, j + 1);
                A(i, j + 1) = ct * temp - st * A(i, j);
                A(i, j) = st * temp + ct * A(i, j);
            }
    }
}

void dlasr_rvb(int m, int n, const double* c, const double* s, const CM& A) {
    for (int j = n - 1; j >= 1; --j) {
        double ct = c[j - 1], st = s[j - 1];
        if (ct != 1.0 || st != 0.0)
            for (int i = 1; i <= m; ++i) {
                double temp = A(i, j + 1);
                A(i, j + 1) = ct * temp - st * A(i, j);
                A(i, j) = st * temp + ct * A(i, j);
            }
    }
}

bool dbdsqr_u(int n, double* D, double* E, const CM& VT, const CM& U) {
    auto d = [&](int i) -> double& { return D[i - 1]; };
    auto e = [&](int i) -> double& { return E[i - 1]; };
    int ncvt = n, nru = n;
    if (n == 1) goto label160;
    {
        const int maxitr = 6;
        int nm1 = n - 1, nm12 = nm1 + nm1, nm13 = nm12 + nm1;
        Vec work(4 * n + 4, 0.0);
        auto w = [&](int i) -> double& { return work[i - 1]; };
        int idir = 0;
        const double eps = EPS * 0.5;
        const double unfl = std::numeric_limits<double>::min();
        double tolmul = std::max(10.0, std::min(100.0, std::pow(eps, -0.125)));
        double tol = tolmul * eps;
        double smax = 0.0;
        for (int i = 1; i <= n; ++i) smax = std::max(smax, std::fabs(d(i)));
        for (int i = 1; i <= n - 1; ++i) smax = std::max(smax, std::fabs(e(i)));
        double smin = 0.0, thresh;
        {
            double sminoa = std::fabs(d(1));
            if (sminoa != 0.0) {
                double mu = sminoa;
                for (int i = 2; i <= n; ++i) {
                    mu = std::fabs(d(i)) * (mu / (mu + std::fabs(e(i - 1))));
                    sminoa = std::min(sminoa, mu);
                    if (sminoa == 0.0) break;
                }
            }
            sminoa = sminoa / std::sqrt(static_cast<double>(n));
            thresh = std::max(tol * sminoa, maxitr * (n * (n * unfl)));
        }
        int maxitdivn = maxitr * n, iterdivn = 0, iter = -1, oldll = -1, oldm = -1, m = n;
        int ll = 0;
        double cs, sn, r, oldcs, oldsn, shift, sll, f, g, h, cosr, sinr, cosl, sinl, sigmn, sigmx;
        while (true) {
            if (m <= 1) break;
            if (iter >= n) {
                iter -= n;
                ++iterdivn;
                if (iterdivn >= maxitdivn) return false;
            }
            smax = std::fabs(d(m));
            bool found = false;
            for (int lll = 1; lll <= m - 1; ++lll) {
                ll = m - lll;
                double abss = std::fabs(d(ll));
                double abse = std::fabs(e(ll));
                if (abse <= thresh) {
                    found = true;
                    break;
                }
                smax = std::max(smax, std::max(abss, abse));
            }
            if (found) {
                e(ll) = 0.0;
                if (ll == m - 1) {
                    m = m - 1;
                    continue;
                }
            } else {
                ll = 0;
            }
            ll = ll + 1;
            if (ll == m - 1) {
                dlasv2(d(m - 1), e(m - 1), d(m), sigmn, sigmx, sinr, cosr, sinl, cosl);
                d(m - 1) = sigmx;
                e(m - 1) = 0.0;
                d(m) = sigmn;
                b_rot(ncvt, VT.at(m - 1, 1), VT.ld, VT.at(m, 1), VT.ld, cosr, sinr);
                b_rot(nru, U.at(1, m - 1), 1, U.at(1, m), 1, cosl, sinl);
                m = m - 2;
                continue;
            }
            if (ll > oldm || m < oldll) idir = (std::fabs(d(ll)) >= std::fabs(d(m))) ? 1 : 2;
            bool restart = false;
            if (idir == 1) {
                if (std::fabs(e(m - 1)) <= std::fabs(tol) * std::fabs(d(m))) {
                    e(m - 1) = 0.0;
                    continue;
                }
                double mu = std::fabs(d(ll));
                smin = mu;
                for (int lll = ll; lll <= m - 1; ++lll) {
                    if (std::fabs(e(lll)) <= tol * mu) {
                        e(lll) = 0.0;
                        restart = true;
                        break;
                    }
                    mu = std::fabs(d(lll + 1)) * (mu / (mu + std::fabs(e(lll))));
                    smin = std::min(smin, mu);
                }
            } else {
                if (std::fabs(e(ll)) <= std::fabs(tol) * std::fabs(d(ll))) {
                    e(ll) = 0.0;
                    continue;
                }
                double mu = std::fabs(d(m));
                smin = mu;
                for (int lll = m - 1; lll >= ll; --lll) {
                    if (std::fabs(e(lll)) <= tol * mu) {
                        e(lll) = 0.0;
                        restart = true;
                        break;
                    }
                    mu = std::fabs(d(lll)) * (mu / (mu + std::fabs(e(lll))));
                    smin = std::min(smin, mu);
                }
            }
            if (restart) continue;
            oldll = ll;
            oldm = m;
            if ((static_cast<double>(n) * tol) * (smin / smax) <= std::max(eps, 0.01 * tol)) {
                shift = 0.0;
            } else {
                if (idir == 1) {
                    sll = std::fabs(d(ll));
                    dlas2(d(m - 1), e(m - 1), d(m), shift, r);
                } else {
                    sll = std::fabs(d(m));
                    dlas2(d(ll), e(ll), d(ll + 1), shift, r);
                }
                if (sll > 0.0) {
                    double q = shift / sll;
                    if (q * q < eps) shift = 0.0;
                }
            }
            iter = iter + m - ll;
            if (shift == 0.0) {
                if (idir == 1) {
                    cs = 1.0;
                    oldcs = 1.0;
                    for (int i = ll; i <= m - 1; ++i) {
                        dlartg(d(i) * cs, e(i), cs, sn, r);
                        if (i > ll) e(i - 1) = oldsn * r;
                        dlartg(oldcs * r, d(i + 1) * sn, oldcs, oldsn, d(i));
                        w(i - ll + 1) = cs;
                        w(i - ll + 1 + nm1) = sn;
                        w(i - ll + 1 + nm12) = oldcs;
                        w(i - ll + 1 + nm13) = oldsn;
                    }
                    h = d(m) * cs;
                    d(m) = h * oldcs;
                    e(m - 1) = h * oldsn;
                    dlasr_lvf(m - ll + 1, ncvt, &w(1), &w(n), CM{VT.at(ll, 1), VT.ld});
                    dlasr_rvf(nru, m - ll + 1, &w(nm12 + 1), &w(nm13 + 1), CM{U.at(1, ll), U.ld});
                    if (std::fabs(e(m - 1)) <= thresh) e(m - 1) = 0.0;
                } else {
                    cs = 1.0;
                    oldcs = 1.0;
                    for (int i = m; i >= ll + 1; --i) {
                        dlartg(d(i) * cs, e(i - 1), cs, sn, r);
                        if (i < m) e(i) = oldsn * r;
                        dlartg(oldcs * r, d(i - 1) * sn, oldcs, oldsn, d(i));
                        w(i - ll) = cs;
                        w(i - ll + nm1) = -sn;
                        w(i - ll + nm12) = oldcs;
                        w(i - ll + nm13) = -oldsn;
                    }
                    h = d(ll) * cs;
                    d(ll) = h * oldcs;
                    e(ll) = h * oldsn;
                    dlasr_lvb(m - ll + 1, ncvt, &w(nm12 + 1), &w(nm13 + 1), CM{VT.at(ll, 1), VT.ld});
                    dlasr_rvb(nru, m - ll + 1, &w(1), &w(n), CM{U.at(1, ll), U.ld});
                    if (std::fabs(e(ll)) <= thresh) e(ll) = 0.0;
                }
            } else {
                if (idir == 1) {
                    f = (std::fabs(d(ll)) - shift) * (f_sign(1.0, d(ll)) + shift / d(ll));
                    g = e(ll);
                    for (int i = ll; i <= m - 1; ++i) {
                        dlartg(f, g, cosr, sinr, r);
                        if (i > ll) e(i - 1) = r;
                        f = cosr * d(i) + sinr * e(i);
                        e(i) = cosr * e(i) - sinr * d(i);
                        g = sinr * d(i + 1);
                        d(i + 1) = cosr * d(i + 1);
                        dlartg(f, g, cosl, sinl, r);
                        d(i) = r;
                        f = cosl * e(i) + sinl * d(i + 1);
                        d(i + 1) = cosl * d(i + 1) - sinl * e(i);
                        if (i < m - 1) {
                            g = sinl * e(i + 1);
                            e(i + 1) = cosl * e(i + 1);
                        }
                        w(i - ll + 1) = cosr;
                        w(i - ll + 1 + nm1) = sinr;
                        w(i - ll + 1 + nm12) = cosl;
                        w(i - ll + 1 + nm13) = sinl;
                    }
                    e(m - 1) = f;
                    dlasr_lvf(m - ll + 1, ncvt, &w(1), &w(n), CM{VT.at(ll, 1), VT.ld});
                    dlasr_rvf(nru, m - ll + 1, &w(nm12 + 1), &w(nm13 + 1), CM{U.at(1, ll), U.ld});
                    if (std::fabs(e(m - 1)) <= thresh) e(m - 1) = 0.0;
                } else {
                    f = (std::fabs(d(m)) - shift) * (f_sign(1.0, d(m)) + shift / d(m));
                    g = e(m - 1);
                    for (int i = m; i >= ll + 1; --i) {
                        dlartg(f, g, cosr, sinr, r);
                        if (i < m) e(i) = r;
                        f = cosr * d(i) + sinr * e(i - 1);
                        e(i - 1) = cosr * e(i - 1) - sinr * d(i);
                        g = sinr * d(i - 1);
                        d(i - 1) = cosr * d(i - 1);
                        dlartg(f, g, cosl, sinl, r);
                        d(i) = r;
                        f = cosl * e(i - 1) + sinl * d(i - 1);
                        d(i - 1) = cosl * d(i - 1) - sinl * e(i - 1);
                        if (i > ll + 1) {
                            g = sinl * e(i - 2);
                            e(i - 2) = cosl * e(i - 2);
                        }
                        w(i - ll) = cosr;
                        w(i - ll + nm1) = -sinr;
                        w(i - ll + nm12) = cosl;
                        w(i - ll + nm13) = -sinl;
                    }
                    e(ll) = f;
                    if (std::fabs(e(ll)) <= thresh) e(ll) = 0.0;
                    dlasr_lvb(m - ll + 1, ncvt, &w(nm12 + 1), &w(nm13 + 1), CM{VT.at(ll, 1), VT.ld});
                    dlasr_rvb(nru, m - ll + 1, &w(1), &w(n), CM{U.at(1, ll), U.ld});
                }
            }
        }
    }
label160:
    for (int i = 1; i <= n; ++i) {
        if (d(i) < 0.0) {
            d(i) = -d(i);
            b_scal(ncvt, -1.0, VT.at(i, 1), VT.ld);
        }
    }
    for (int i = 1; i <= n - 1; ++i) {
        int isub = 1;
        double smin = d(1);
        for (int j = 2; j <= n + 1 - i; ++j)
            if (d(j) <= smin) {
                isub = j;
                smin = d(j);
            }
        if (isub != n + 1 - i) {
            d(isub) = d(n + 1 - i);
            d(n + 1 - i) = smin;
            b_swap(ncvt, VT.at(isub, 1), VT.ld, VT.at(n + 1 - i, 1), VT.ld);
            b_swap(nru, U.at(1, isub), 1, U.at(1, n + 1 - i), 1);
        }
    }
    return true;
}

bool dbdsdc_ui(int n, double* D, double* E, const CM& U, const CM& VT) {
    if (n == 1) {
        U(1, 1) = f_sign(1.0, D[0]);
        VT(1, 1) = 1.0;
        D[0] = std::fabs(D[0]);
        return true;
    }
    for (int j = 1; j <= n; ++j)
        for (int i = 1; i <= n; ++i) {
            U(i, j) = (i == j) ? 1.0 : 0.0;
            VT(i, j) = (i == j) ? 1.0 : 0.0;
        }
    if (!dbdsqr_u(n, D, E, VT, U)) return false;
    for (int i = 1; i <= n; ++i) {
        int isub = i;
        double smin = D[i - 1];
        for (int j = i + 1; j <= n; ++j)
            if (D[j - 1] < smin) {
                isub = j;
                smin = D[j - 1];
            }
        if (isub != i) {
            D[isub - 1] = D[i - 1];
            D[i - 1] = smin;
            b_swap(n, VT.at(isub, 1), VT.ld, VT.at(i, 1), VT.ld);
            b_swap(n, U.at(1, isub), 1, U.at(1, i), 1);
        }
    }
    for (int ii = 2; ii <= n; ++ii) {
        int i = ii - 1, kk = i;
        double p = D[i - 1];
        for (int j = ii; j <= n; ++j)
            if (D[j - 1] > p) {
                kk = j;
                p = D[j - 1];
            }
        if (kk != i) {
            D[kk - 1] = D[i - 1];
            D[i - 1] = p;
            b_swap(n, U.at(1, i), 1, U.at(1, kk), 1);
            b_swap(n, VT.at(i, 1), VT.ld, VT.at(kk, 1), VT.ld);
        }
    }
    return true;
}

void dgebd2_tall(int m, int n, const CM& A, double* d, double* e, double* tauq, double* taup) {
    Vec work(std::max(m, n) + 1);
    for (int i = 1; i <= n; ++i) {
        dlarfg(m - i + 1, A(i, i), A.at(std::min(i + 1, m), i), 1, tauq[i - 1]);
        d[i - 1] = A(i, i);
        if (i < n) apply_reflector(true, m - i + 1, n - i, A.at(i, i), 1, tauq[i - 1], CM{A.at(i, i + 1), A.ld}, work.data());
        if (i < n) {
            dlarfg(n - i, A(i, i + 1), A.at(i, std::min(i + 2, n)), A.ld, taup[i - 1]);
            e[i - 1] = A(i, i + 1);
            apply_reflector(false, m - i, n - i, A.at(i, i + 1), A.ld, taup[i - 1], CM{A.at(i + 1, i + 1), A.ld},
                    work.data());
        } else {
            taup[i - 1] = 0.0;
        }
    }
}

void dorm2r_ln(int m, int n, int k, const CM& A, const double* tau, const CM& C) {
    Vec work(std::max(m, n) + 1);
    for (int i = k; i >= 1; --i) apply_reflector(true, m - i + 1, n, A.at(i, i), 1, tau[i - 1], CM{C.at(i, 1), C.ld}, work.data());
}

void dorml2_rn(int m, int n, int k, const CM& A, const double* tau, const CM& C) {
    Vec work(std::max(m, n) + 1);
    for (int i = k; i >= 1; --i)
        apply_reflector(false, m, n - i + 1, A.at(i, i), A.ld, tau[i - 1], CM{C.at(1, i), C.ld}, work.data());
}

void dgeqr2(int m, int n, const CM& A, double* tau) {
    Vec work(n + 1);
    int k = std::min(m, n);
    for (int i = 1; i <= k; ++i) {
        dlarfg(m - i + 1, A(i, i), A.at(std::min(i + 1, m), i), 1, tau[i - 1]);
        if (i < n) apply_reflector(true, m - i + 1, n - i, A.at(i, i), 1, tau[i - 1], CM{A.at(i, i + 1), A.ld}, work.data());
    }
}

void dorg2r(int m, int n, int k, const CM& A, const double* tau) {
    Vec work(n + 1);
    for (int j = k + 1; j <= n; ++j) {
        for (int l = 1; l <= m; ++l) A(l, j) = 0.0;
        A(j, j) = 1.0;
    }
    for (int i = k; i >= 1; --i) {
        if (i < n) {
            A(i, i) = 1.0;
            apply_reflector(true, m - i + 1, n - i, A.at(i, i), 1, tau[i - 1], CM{A.at(i, i + 1), A.ld}, work.data());
        }
        if (i < m) b_scal(m - i, -tau[i - 1], A.at(i + 1, i), 1);
        A(i, i) = 1.0 - tau[i - 1];
        for (int l = 1; l <= i - 1; ++l) A(l, i) = 0.0;
    }
}

void dormbr_prt(int n, const CM& A, const double* taup, const CM& VT) {
    if (n > 1) dorml2_rn(n, n - 1, n - 1, CM{A.at(1, 2), A.ld}, taup, CM{VT.at(1, 2), VT.ld});
}

bool svd_gesdd(const Mat& Ain, Mat& Uo, Vec& so, Mat& Vo) {
    int m = static_cast<int>(Ain.size());
    int n = static_cast<int>(Ain[0].size());
    if (m < n) return false;
    std::vector<double> a(static_cast<std::size_t>(m) * n);
    CM A{a.data(), m};
    for (int i = 1; i <= m; ++i)
        for (int j = 1; j <= n; ++j) A(i, j) = Ain[i - 1][j - 1];
    double anrm = 0.0;
    for (double v : a) {
        double t = std::fabs(v);
        if (std::isnan(t)) return false;
        anrm = std::max(anrm, t);
    }
    const double smlnum = std::sqrt(std::numeric_limits<double>::min()) / (EPS * 0.5);
    if ((anrm > 0.0 && anrm < smlnum) || anrm > 1.0 / smlnum) return false;
    int mnthr = static_cast<int>(n * 11.0 / 6.0);
    Vec s(n), e(n), tauq(n), taup(n), tau(n);
    std::vector<double> u(static_cast<std::size_t>(m) * n, 0.0), vt(static_cast<std::size_t>(n) * n, 0.0);
    CM U{u.data(), m}, VT{vt.data(), n};
    if (m >= mnthr) {
        dgeqr2(m, n, A, tau.data());
        std::vector<double> r(static_cast<std::size_t>(n) * n, 0.0);
        CM R{r.data(), n};
        for (int j = 1; j <= n; ++j)
            for (int i = 1; i <= j; ++i) R(i, j) = A(i, j);
        dorg2r(m, n, n, A, tau.data());
        dgebd2_tall(n, n, R, s.data(), e.data(), tauq.data(), taup.data());
        std::vector<double> ur(static_cast<std::size_t>(n) * n, 0.0);
        CM UR{ur.data(), n};
        if (!dbdsdc_ui(n, s.data(), e.data(), UR, VT)) return false;
        dorm2r_ln(n, n, n, R, tauq.data(), UR);
        dormbr_prt(n, R, taup.data(), VT);
        for (int i = 1; i <= m; ++i)
            for (int j = 1; j <= n; ++j) {
                double acc = A(i, 1) * UR(1, j);
                for (int l = 2; l <= n; ++l) acc = std::fma(A(i, l), UR(l, j), acc);
                U(i, j) = acc;
            }
    } else {
        dgebd2_tall(m, n, A, s.data(), e.data(), tauq.data(), taup.data());
        if (!dbdsdc_ui(n, s.data(), e.data(), U, VT)) return false;
        dorm2r_ln(m, n, n, A, tauq.data(), U);
        dormbr_prt(n, A, taup.data(), VT);
    }
    Uo.assign(m, Vec(n));
    Vo.assign(n, Vec(n));
    so = s;
    for (int i = 1; i <= m; ++i)
        for (int j = 1; j <= n; ++j) Uo[i - 1][j - 1] = U(i, j);
    for (int i = 1; i <= n; ++i)
        for (int j = 1; j <= n; ++j) Vo[j - 1][i - 1] = VT(i, j);
    return true;
}

std::vector<int> find_active_constraints(const Vec& x, const Vec& lb, const Vec& ub, double rtol) {
    std::size_t n = x.size();
    std::vector<int> active(n, 0);
    if (rtol == 0) {
        for (std::size_t i = 0; i < n; ++i) {
            if (x[i] <= lb[i]) active[i] = -1;
            if (x[i] >= ub[i]) active[i] = 1;
        }
        return active;
    }
    for (std::size_t i = 0; i < n; ++i) {
        double lower_dist = x[i] - lb[i];
        double upper_dist = ub[i] - x[i];
        double lower_threshold = rtol * std::max(1.0, std::fabs(lb[i]));
        double upper_threshold = rtol * std::max(1.0, std::fabs(ub[i]));
        if (std::isfinite(lb[i]) && lower_dist <= std::min(upper_dist, lower_threshold)) active[i] = -1;
        if (std::isfinite(ub[i]) && upper_dist <= std::min(lower_dist, upper_threshold)) active[i] = 1;
    }
    return active;
}

Vec make_strictly_feasible(const Vec& x, const Vec& lb, const Vec& ub, double rstep) {
    Vec x_new = x;
    std::vector<int> active = find_active_constraints(x, lb, ub, rstep);
    for (std::size_t i = 0; i < x.size(); ++i) {
        if (rstep == 0) {
            if (active[i] == -1) x_new[i] = std::nextafter(lb[i], ub[i]);
            if (active[i] == 1) x_new[i] = std::nextafter(ub[i], lb[i]);
        } else {
            if (active[i] == -1) x_new[i] = lb[i] + rstep * std::max(1.0, std::fabs(lb[i]));
            if (active[i] == 1) x_new[i] = ub[i] - rstep * std::max(1.0, std::fabs(ub[i]));
        }
    }
    for (std::size_t i = 0; i < x.size(); ++i)
        if (x_new[i] < lb[i] || x_new[i] > ub[i]) x_new[i] = 0.5 * (lb[i] + ub[i]);
    return x_new;
}

bool in_bounds(const Vec& x, const Vec& lb, const Vec& ub) {
    for (std::size_t i = 0; i < x.size(); ++i)
        if (!(x[i] >= lb[i] && x[i] <= ub[i])) return false;
    return true;
}

std::pair<double, std::vector<int>> step_size_to_bound(const Vec& x, const Vec& s, const Vec& lb, const Vec& ub) {
    std::size_t n = x.size();
    Vec steps(n, INF);
    for (std::size_t i = 0; i < n; ++i)
        if (s[i] != 0) {
            double a = (lb[i] - x[i]) / s[i];
            double b = (ub[i] - x[i]) / s[i];
            steps[i] = (std::isnan(a) || std::isnan(b)) ? std::nan("") : std::max(a, b);
        }
    double min_step = steps[0];
    for (double v : steps) {
        if (std::isnan(v)) {
            min_step = v;
            break;
        }
        if (v < min_step) min_step = v;
    }
    std::vector<int> hits(n);
    for (std::size_t i = 0; i < n; ++i)
        hits[i] = (steps[i] == min_step ? 1 : 0) * static_cast<int>(sign_of(s[i]));
    return {min_step, hits};
}

std::pair<double, double> intersect_trust_region(const Vec& x, const Vec& s, double Delta) {
    double a = npdot(s, s);
    if (a == 0) throw ValueError("`s` is zero.");
    double b = npdot(x, s);
    double c = npdot(x, x) - pypow(Delta, 2);
    if (c > 0) throw ValueError("`x` is not within the trust region.");
    double d = std::sqrt(b * b - a * c);
    double q = -(b + std::copysign(d, b));
    double t1 = q / a;
    double t2 = c / q;
    if (t1 < t2) return {t1, t2};
    return {t2, t1};
}

double evaluate_quadratic(const Mat& J, const Vec& g, const Vec& s, const Vec& diag) {
    Vec Js = jvec(J, s);
    double q = npdot(Js, Js);
    Vec sd(s.size());
    for (std::size_t i = 0; i < s.size(); ++i) sd[i] = s[i] * diag[i];
    q += npdot(sd, s);
    double l = npdot(s, g);
    return 0.5 * q + l;
}

std::array<double, 3> build_quadratic_1d(const Mat& J, const Vec& g, const Vec& s, const Vec& diag,
                                         const Vec* s0) {
    Vec v = jvec(J, s);
    double a = npdot(v, v);
    Vec sd(s.size());
    for (std::size_t i = 0; i < s.size(); ++i) sd[i] = s[i] * diag[i];
    a += npdot(sd, s);
    a *= 0.5;
    double b = npdot(g, s);
    double c = 0.0;
    if (s0) {
        Vec u = jvec(J, *s0);
        b += npdot(u, v);
        c = 0.5 * npdot(u, u) + npdot(g, *s0);
        Vec s0d(s0->size());
        for (std::size_t i = 0; i < s0->size(); ++i) s0d[i] = (*s0)[i] * diag[i];
        b += npdot(s0d, s);
        c += 0.5 * npdot(s0d, *s0);
    }
    return {a, b, c};
}

std::pair<double, double> minimize_quadratic_1d(double a, double b, double lb, double ub, double c) {
    Vec t{lb, ub};
    if (a != 0) {
        double extremum = -0.5 * b / a;
        if (lb < extremum && extremum < ub) t.push_back(extremum);
    }
    std::size_t imin = 0;
    double ymin = 0.0;
    for (std::size_t i = 0; i < t.size(); ++i) {
        double y = t[i] * (a * t[i] + b) + c;
        if (i == 0 || (!std::isnan(ymin) && (std::isnan(y) || y < ymin))) {
            imin = i;
            ymin = y;
        }
    }
    return {t[imin], ymin};
}

struct TrSolution {
    Vec p;
    double alpha;
    int n_iter;
};

TrSolution solve_lsq_trust_region(std::size_t n, std::size_t m, const Vec& uf, const Vec& s, const Mat& V,
                                  double Delta, double initial_alpha, double rtol = 0.01, int max_iter = 10) {
    std::size_t k = s.size();
    Vec suf(k);
    for (std::size_t i = 0; i < k; ++i) suf[i] = s[i] * uf[i];
    auto phi_and_derivative = [&](double alpha) {
        Vec denom(k), q(k);
        for (std::size_t i = 0; i < k; ++i) denom[i] = s[i] * s[i] + alpha;
        for (std::size_t i = 0; i < k; ++i) q[i] = suf[i] / denom[i];
        double p_norm = npnorm(q);
        double phi = p_norm - Delta;
        double sum = 0.0;
        for (std::size_t i = 0; i < k; ++i) sum = sum + (suf[i] * suf[i]) / pypow(denom[i], 3);
        double phi_prime = -sum / p_norm;
        return std::pair<double, double>(phi, phi_prime);
    };
    bool full_rank = false;
    if (m >= n) {
        double threshold = EPS * static_cast<double>(m) * s[0];
        full_rank = s[k - 1] > threshold;
    }
    if (full_rank) {
        Vec q(k);
        for (std::size_t i = 0; i < k; ++i) q[i] = uf[i] / s[i];
        Vec p = matvec(V, q);
        for (auto& v : p) v = -v;
        if (npnorm(p) <= Delta) return {p, 0.0, 0};
    }
    double alpha_upper = npnorm(suf) / Delta;
    double alpha_lower = 0.0;
    if (full_rank) {
        auto [phi, phi_prime] = phi_and_derivative(0.0);
        alpha_lower = -phi / phi_prime;
    }
    double alpha;
    if (!full_rank && initial_alpha == 0)
        alpha = py_max(0.001 * alpha_upper, pypow(alpha_lower * alpha_upper, 0.5));
    else
        alpha = initial_alpha;
    int it = 0;
    for (it = 0; it < max_iter; ++it) {
        if (alpha < alpha_lower || alpha > alpha_upper)
            alpha = py_max(0.001 * alpha_upper, pypow(alpha_lower * alpha_upper, 0.5));
        auto [phi, phi_prime] = phi_and_derivative(alpha);
        if (phi < 0) alpha_upper = alpha;
        double ratio = phi / phi_prime;
        alpha_lower = py_max(alpha_lower, alpha - ratio);
        alpha -= (phi + Delta) * ratio / Delta;
        if (std::fabs(phi) < rtol * Delta) break;
    }
    if (it == max_iter) it = max_iter - 1;
    Vec q(k);
    for (std::size_t i = 0; i < k; ++i) q[i] = suf[i] / (s[i] * s[i] + alpha);
    Vec p = matvec(V, q);
    for (auto& v : p) v = -v;
    double sc = Delta / npnorm(p);
    for (auto& v : p) v *= sc;
    return {p, alpha, it + 1};
}

struct Step {
    Vec step;
    Vec step_h;
    double predicted;
};

Step select_step(const Vec& x, const Mat& J_h, const Vec& diag_h, const Vec& g_h, Vec p, Vec p_h, const Vec& d,
                 double Delta, const Vec& lb, const Vec& ub, double theta) {
    std::size_t n = x.size();
    Vec xp(n);
    for (std::size_t i = 0; i < n; ++i) xp[i] = x[i] + p[i];
    if (in_bounds(xp, lb, ub)) {
        double p_value = evaluate_quadratic(J_h, g_h, p_h, diag_h);
        return {p, p_h, -p_value};
    }
    auto [p_stride, hits] = step_size_to_bound(x, p, lb, ub);
    Vec r_h = p_h;
    for (std::size_t i = 0; i < n; ++i)
        if (hits[i] != 0) r_h[i] *= -1;
    Vec r(n);
    for (std::size_t i = 0; i < n; ++i) r[i] = d[i] * r_h[i];
    for (auto& v : p) v *= p_stride;
    for (auto& v : p_h) v *= p_stride;
    Vec x_on_bound(n);
    for (std::size_t i = 0; i < n; ++i) x_on_bound[i] = x[i] + p[i];
    double to_tr = intersect_trust_region(p_h, r_h, Delta).second;
    double to_bound = step_size_to_bound(x_on_bound, r, lb, ub).first;
    double r_stride = py_min(to_bound, to_tr);
    double r_stride_l, r_stride_u;
    if (r_stride > 0) {
        r_stride_l = (1 - theta) * p_stride / r_stride;
        if (r_stride == to_bound)
            r_stride_u = theta * to_bound;
        else
            r_stride_u = to_tr;
    } else {
        r_stride_l = 0;
        r_stride_u = -1;
    }
    double r_value;
    if (r_stride_l <= r_stride_u) {
        auto abc = build_quadratic_1d(J_h, g_h, r_h, diag_h, &p_h);
        auto [rs, rv] = minimize_quadratic_1d(abc[0], abc[1], r_stride_l, r_stride_u, abc[2]);
        r_value = rv;
        for (auto& v : r_h) v *= rs;
        for (std::size_t i = 0; i < n; ++i) r_h[i] += p_h[i];
        for (std::size_t i = 0; i < n; ++i) r[i] = r_h[i] * d[i];
    } else {
        r_value = INF;
    }
    for (auto& v : p) v *= theta;
    for (auto& v : p_h) v *= theta;
    double p_value = evaluate_quadratic(J_h, g_h, p_h, diag_h);
    Vec ag_h(n), ag(n);
    for (std::size_t i = 0; i < n; ++i) ag_h[i] = -g_h[i];
    for (std::size_t i = 0; i < n; ++i) ag[i] = d[i] * ag_h[i];
    to_tr = Delta / npnorm(ag_h);
    to_bound = step_size_to_bound(x, ag, lb, ub).first;
    double ag_stride = (to_bound < to_tr) ? theta * to_bound : to_tr;
    auto ab = build_quadratic_1d(J_h, g_h, ag_h, diag_h, nullptr);
    auto [ags, ag_value] = minimize_quadratic_1d(ab[0], ab[1], 0, ag_stride, 0);
    for (auto& v : ag_h) v *= ags;
    for (auto& v : ag) v *= ags;
    if (p_value < r_value && p_value < ag_value) return {p, p_h, -p_value};
    if (r_value < p_value && r_value < ag_value) return {r, r_h, -r_value};
    return {ag, ag_h, -ag_value};
}

std::pair<double, double> update_tr_radius(double Delta, double actual_reduction, double predicted_reduction,
                                           double step_norm, bool bound_hit) {
    double ratio;
    if (predicted_reduction > 0)
        ratio = actual_reduction / predicted_reduction;
    else if (predicted_reduction == actual_reduction && actual_reduction == 0)
        ratio = 1;
    else
        ratio = 0;
    if (ratio < 0.25)
        Delta = 0.25 * step_norm;
    else if (ratio > 0.75 && bound_hit)
        Delta *= 2.0;
    return {Delta, ratio};
}

int check_termination(double dF, double F, double dx_norm, double x_norm, double ratio, double ftol, double xtol) {
    bool ftol_satisfied = dF < ftol * F && ratio > 0.25;
    bool xtol_satisfied = dx_norm < xtol * (xtol + x_norm);
    if (ftol_satisfied && xtol_satisfied) return 4;
    if (ftol_satisfied) return 2;
    if (xtol_satisfied) return 3;
    return 0;
}

void CL_scaling_vector(const Vec& x, const Vec& g, const Vec& lb, const Vec& ub, Vec& v, Vec& dv) {
    std::size_t n = x.size();
    v.assign(n, 1.0);
    dv.assign(n, 0.0);
    for (std::size_t i = 0; i < n; ++i)
        if (g[i] < 0 && std::isfinite(ub[i])) {
            v[i] = ub[i] - x[i];
            dv[i] = -1;
        }
    for (std::size_t i = 0; i < n; ++i)
        if (g[i] > 0 && std::isfinite(lb[i])) {
            v[i] = x[i] - lb[i];
            dv[i] = 1;
        }
}

bool all_finite(const Vec& v) {
    for (double x : v)
        if (!std::isfinite(x)) return false;
    return true;
}

struct VectorFunction {
    const Residual& fun;
    Vec lb, ub;
    std::optional<double> rel_step;
    Vec x;
    Vec f;
    bool f_updated = false;
    Mat J;
    bool J_updated = false;

    Vec call(const Vec& xx) {
        Vec r = fun(xx);
        return r;
    }

    void update_x(const Vec& xx) {
        if (xx != x) {
            x = xx;
            f_updated = false;
            J_updated = false;
        }
    }

    void update_fun() {
        if (!f_updated) {
            f = call(x);
            f_updated = true;
        }
    }

    Mat approx_derivative() {
        std::size_t n = x.size();
        double rstep = pypow(EPS, 0.5);
        Vec h(n);
        for (std::size_t i = 0; i < n; ++i) {
            double sign_x0 = (x[i] >= 0 ? 1.0 : 0.0) * 2 - 1;
            double def = rstep * sign_x0 * std::max(1.0, std::fabs(x[i]));
            if (!rel_step) {
                h[i] = def;
            } else {
                double abs_step = *rel_step * sign_x0 * std::fabs(x[i]);
                double dx = (x[i] + abs_step) - x[i];
                h[i] = (dx == 0) ? def : abs_step;
            }
        }
        bool unbounded = true;
        for (std::size_t i = 0; i < n; ++i)
            if (!(lb[i] == -INF && ub[i] == INF)) unbounded = false;
        if (!unbounded) {
            Vec h_adj = h;
            for (std::size_t i = 0; i < n; ++i) {
                double lower_dist = x[i] - lb[i];
                double upper_dist = ub[i] - x[i];
                double xt = x[i] + h[i];
                bool violated = (xt < lb[i]) || (xt > ub[i]);
                bool fitting = std::fabs(h[i]) <= std::max(lower_dist, upper_dist);
                if (violated && fitting) h_adj[i] *= -1;
                if ((upper_dist >= lower_dist) && !fitting) h_adj[i] = upper_dist / 1;
                if ((upper_dist < lower_dist) && !fitting) h_adj[i] = -lower_dist / 1;
            }
            h = h_adj;
        }
        std::size_t m = f.size();
        Mat Jm(m, Vec(n));
        for (std::size_t i = 0; i < n; ++i) {
            Vec x1 = x;
            x1[i] = x[i] + h[i];
            Vec fe = call(x1);
            if (fe.size() != m) throw ValueError("`fun` returned residuals of inconsistent size.");
            double dx = (x[i] + h[i]) - x[i];
            for (std::size_t r = 0; r < m; ++r) Jm[r][i] = (fe[r] - f[r]) / dx;
        }
        return Jm;
    }

    void update_jac() {
        if (!J_updated) {
            update_fun();
            J = approx_derivative();
            J_updated = true;
        }
    }

    Vec value(const Vec& xx) {
        update_x(xx);
        update_fun();
        return f;
    }

    Mat jac(const Vec& xx) {
        update_x(xx);
        update_jac();
        return J;
    }
};

}

LsqResult least_squares(const Residual& fun, const Vec& x0_in, const LsqOptions& o) {
    std::size_t n = x0_in.size();
    if (o.max_nfev && *o.max_nfev <= 0) throw ValueError("`max_nfev` must be None or positive integer.");
    Vec lb = o.lb.empty() ? Vec(n, -INF) : o.lb;
    Vec ub = o.ub.empty() ? Vec(n, INF) : o.ub;
    if (lb.size() == 1 && n != 1) lb.assign(n, lb[0]);
    if (ub.size() == 1 && n != 1) ub.assign(n, ub[0]);
    if (lb.size() != n || ub.size() != n) throw ValueError("Inconsistent shapes between bounds and `x0`.");
    for (std::size_t i = 0; i < n; ++i)
        if (lb[i] >= ub[i]) throw ValueError("Each lower bound must be strictly less than each upper bound.");
    if (!in_bounds(x0_in, lb, ub)) throw ValueError("Initial guess is outside of provided bounds");
    Vec x_scale = o.x_scale.empty() ? Vec(n, 1.0) : o.x_scale;
    if (x_scale.size() == 1 && n != 1) x_scale.assign(n, x_scale[0]);
    if (x_scale.size() != n) throw ValueError("Inconsistent shapes between `x_scale` and `x0`.");
    for (double v : x_scale)
        if (!(std::isfinite(v) && v > 0)) throw ValueError("`x_scale` must be 'jac' or array_like with positive numbers.");
    double ftol = o.ftol, xtol = o.xtol, gtol = o.gtol;
    if (ftol < EPS && xtol < EPS && gtol < EPS)
        throw ValueError("At least one of the tolerances must be higher than machine epsilon.");
    bool unbounded = true;
    for (std::size_t i = 0; i < n; ++i)
        if (!(lb[i] == -INF && ub[i] == INF)) unbounded = false;
    if (unbounded) throw ValueError("least_squares port: trf without bounds is not implemented");
    Vec x0 = make_strictly_feasible(x0_in, lb, ub, 1e-10);

    VectorFunction vf{fun, lb, ub, o.diff_step, x0, {}, false, {}, false};
    vf.update_fun();
    Vec f0 = vf.f;
    Mat J0 = vf.jac(x0);
    if (!all_finite(f0)) throw ValueError("Residuals are not finite in the initial point.");
    std::size_t m = f0.size();

    Vec x = x0;
    Vec f = f0;
    Vec f_true = f;
    int nfev = 1;
    Mat J = J0;
    int njev = 1;
    double cost = 0.5 * npdot(f, f);
    Vec g = jtvec(J, f);
    Vec scale = x_scale, scale_inv(n);
    for (std::size_t i = 0; i < n; ++i) scale_inv[i] = 1 / x_scale[i];
    Vec v, dv;
    CL_scaling_vector(x, g, lb, ub, v, dv);
    for (std::size_t i = 0; i < n; ++i)
        if (dv[i] != 0) v[i] *= scale_inv[i];
    Vec tmp(n);
    for (std::size_t i = 0; i < n; ++i) tmp[i] = x0[i] * scale_inv[i] / std::sqrt(v[i]);
    double Delta = npnorm(tmp);
    if (Delta == 0) Delta = 1.0;
    Vec gv(n);
    for (std::size_t i = 0; i < n; ++i) gv[i] = g[i] * v[i];
    double g_norm = norm_inf(gv);
    Vec f_augmented(m + n, 0.0);
    Mat J_augmented(m + n, Vec(n, 0.0));
    int max_nfev = o.max_nfev ? *o.max_nfev : static_cast<int>(n) * 100;
    double alpha = 0.0;
    int termination_status = -100;
    double actual_reduction = 0.0;
    while (true) {
        CL_scaling_vector(x, g, lb, ub, v, dv);
        for (std::size_t i = 0; i < n; ++i) gv[i] = g[i] * v[i];
        g_norm = norm_inf(gv);
        if (g_norm < gtol) termination_status = 1;
        if (termination_status != -100 || nfev == max_nfev) break;
        for (std::size_t i = 0; i < n; ++i)
            if (dv[i] != 0) v[i] *= scale_inv[i];
        Vec d(n), diag_h(n), g_h(n);
        for (std::size_t i = 0; i < n; ++i) d[i] = std::sqrt(v[i]) * scale[i];
        for (std::size_t i = 0; i < n; ++i) diag_h[i] = g[i] * dv[i] * scale[i];
        for (std::size_t i = 0; i < n; ++i) g_h[i] = d[i] * g[i];
        for (std::size_t i = 0; i < m; ++i) f_augmented[i] = f[i];
        for (std::size_t i = 0; i < m; ++i)
            for (std::size_t j = 0; j < n; ++j) J_augmented[i][j] = J[i][j] * d[j];
        Mat J_h(J_augmented.begin(), J_augmented.begin() + m);
        for (std::size_t i = 0; i < n; ++i)
            for (std::size_t j = 0; j < n; ++j) J_augmented[m + i][j] = (i == j) ? std::sqrt(diag_h[i]) : 0.0;
        Mat U, V;
        Vec s;
        if (!svd_gesdd(J_augmented, U, s, V)) throw std::runtime_error("SVD did not converge");
        Vec uf = gemv_n(U, m + n, f_augmented.data(), n);
        double theta = py_max(0.995, 1 - g_norm);
        actual_reduction = -1;
        Vec x_new, f_new;
        double cost_new = 0.0;
        while (actual_reduction <= 0 && nfev < max_nfev) {
            TrSolution tr = solve_lsq_trust_region(n, m, uf, s, V, Delta, alpha);
            alpha = tr.alpha;
            Vec p(n);
            for (std::size_t i = 0; i < n; ++i) p[i] = d[i] * tr.p[i];
            Step st = select_step(x, J_h, diag_h, g_h, p, tr.p, d, Delta, lb, ub, theta);
            Vec xs(n);
            for (std::size_t i = 0; i < n; ++i) xs[i] = x[i] + st.step[i];
            x_new = make_strictly_feasible(xs, lb, ub, 0);
            f_new = vf.value(x_new);
            nfev += 1;
            double step_h_norm = npnorm(st.step_h);
            if (!all_finite(f_new)) {
                Delta = 0.25 * step_h_norm;
                continue;
            }
            cost_new = 0.5 * npdot(f_new, f_new);
            actual_reduction = cost - cost_new;
            auto [Delta_new, ratio] =
                update_tr_radius(Delta, actual_reduction, st.predicted, step_h_norm, step_h_norm > 0.95 * Delta);
            double step_norm = npnorm(st.step);
            int ts = check_termination(actual_reduction, cost, step_norm, npnorm(x), ratio, ftol, xtol);
            if (ts != 0) {
                termination_status = ts;
                break;
            }
            alpha *= Delta / Delta_new;
            Delta = Delta_new;
        }
        if (actual_reduction > 0) {
            x = x_new;
            f = f_new;
            f_true = f;
            cost = cost_new;
            J = vf.jac(x);
            njev += 1;
            g = jtvec(J, f);
        } else {
            actual_reduction = 0;
        }
    }
    if (termination_status == -100) termination_status = 0;
    LsqResult r;
    r.x = x;
    r.cost = cost;
    r.fun = f_true;
    r.jac = J;
    r.grad = g;
    r.optimality = g_norm;
    r.active_mask = find_active_constraints(x, lb, ub, xtol);
    r.nfev = nfev;
    r.njev = njev;
    r.status = termination_status;
    static const char* messages[] = {"The maximum number of function evaluations is exceeded.",
                                     "`gtol` termination condition is satisfied.",
                                     "`ftol` termination condition is satisfied.",
                                     "`xtol` termination condition is satisfied.",
                                     "Both `ftol` and `xtol` termination conditions are satisfied."};
    r.message = messages[termination_status];
    r.success = termination_status > 0;
    return r;
}

}
