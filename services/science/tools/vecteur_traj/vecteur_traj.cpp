#include <SpiceUsr.h>

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <nlohmann/json.hpp>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include "least_squares.hpp"
#include "scipy_port.hpp"
#include "spice.hpp"

namespace selene::vt {

namespace fs = std::filesystem;
using json = nlohmann::ordered_json;
using V3 = std::array<double, 3>;
using V6 = std::array<double, 6>;

constexpr double PI = 3.141592653589793;
constexpr double GM_EARTH = 398600.435436;
constexpr double GM_MOON = 4902.800066;
constexpr double GM_SUN = 132712440041.9394;
constexpr double R_EARTH = 6378.137;
constexpr double R_MOON = 1737.4;
constexpr double VITESSE_DEPART_FIXE_KMS = 10.92;
constexpr double ALTITUDE_DEPART_FIXE_KM = 200.0;
constexpr double MASSE_INITIALE_KG = 15000.0;
constexpr double CARBURANT_INITIAL_KG = 8000.0;
constexpr double MASSE_SECHE_KG = MASSE_INITIALE_KG - CARBURANT_INITIAL_KG;
constexpr bool CARBURANT_ILLIMITE = true;
constexpr double POUSSEE_MAX_N = 45000.0;
constexpr double ISP_S = 311.0;
constexpr double G0_M_S2 = 9.80665;
constexpr double VITESSE_CONTACT_MS = 2.0;
constexpr double MARGE_FREINAGE = 1.30;

struct SpiceyError : std::exception {
    std::string msg;
    explicit SpiceyError(std::string m) : msg(std::move(m)) {}
    const char* what() const noexcept override { return msg.c_str(); }
};

void spice_check() {
    if (!failed_c()) return;
    SpiceChar lng[1841];
    getmsg_c("LONG", sizeof lng, lng);
    reset_c();
    throw SpiceyError(lng);
}

V6 etat_lune(double et) {
    V6 s;
    double lt;
    spkezr_c("MOON", et, "J2000", "NONE", "EARTH", s.data(), &lt);
    spice_check();
    return s;
}

V3 position_soleil(double et) {
    V3 p;
    double lt;
    spkpos_c("SUN", et, "J2000", "NONE", "EARTH", p.data(), &lt);
    spice_check();
    return p;
}

void sxform(const char* from, const char* to, double et, double (&m)[6][6]) {
    sxform_c(from, to, et, m);
    spice_check();
}

double str2et(const std::string& s) {
    double et;
    str2et_c(s.c_str(), &et);
    spice_check();
    return et;
}

std::string et2utc(double et) {
    SpiceChar out[64];
    et2utc_c(et, "ISOC", 3, sizeof out, out);
    spice_check();
    return out;
}

double norme(const double* v) { return npnorm(v, 3); }
double norme(const V3& v) { return npnorm(v.data(), 3); }

V3 sub3(const double* a, const double* b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }

double dot3(const double* a, const double* b) { return npdot(a, b, 3); }

V3 cross(const V3& a, const V3& b) {
    return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}

V3 unitaire(const V3& v) {
    double n = norme(v);
    if (n < 1e-14) throw ValueError("Impossible de normaliser un vecteur nul.");
    return {v[0] / n, v[1] / n, v[2] / n};
}

double radians(double d) { return d * (PI / 180.0); }

double clip(double v, double lo, double hi) {
    if (std::isnan(v)) return v;
    return std::min(std::max(v, lo), hi);
}

double py_max(double a, double b) { return b > a ? b : a; }
double py_min(double a, double b) { return b < a ? b : a; }

V3 site_moon_me(double latitude_deg, double longitude_est_deg, double altitude_km) {
    if (!(-90 <= latitude_deg && latitude_deg <= 90) || altitude_km < 0)
        throw ValueError("Latitude ou altitude du site invalide.");
    double phi = radians(latitude_deg), lam = radians(longitude_est_deg);
    double r = R_MOON + altitude_km;
    return {r * (std::cos(phi) * std::cos(lam)), r * (std::cos(phi) * std::sin(lam)), r * std::sin(phi)};
}

V6 etat_site(double et, const V3& point_moon_me) {
    V6 moon_state = etat_lune(et);
    double transform[6][6];
    sxform("MOON_ME", "J2000", et, transform);
    double fixe[6] = {point_moon_me[0], point_moon_me[1], point_moon_me[2], 0., 0., 0.};
    auto r = matvec6(transform, fixe);
    V6 out;
    for (int i = 0; i < 6; ++i) out[i] = moon_state[i] + r[i];
    return out;
}

V3 gravite(const double* r, const V3& moon, const V3& sun) {
    double nr3 = pypow(norme(r), 3);
    V3 acc;
    for (int i = 0; i < 3; ++i) acc[i] = -GM_EARTH * r[i] / nr3;
    const std::pair<double, const V3*> corps[2] = {{GM_MOON, &moon}, {GM_SUN, &sun}};
    for (const auto& [gm, rbp] : corps) {
        const V3& rb = *rbp;
        V3 dr = sub3(rb.data(), r);
        double nd3 = pypow(norme(dr), 3);
        double nb3 = pypow(norme(rb), 3);
        for (int i = 0; i < 3; ++i) acc[i] += gm * (dr[i] / nd3 - rb[i] / nb3);
    }
    return acc;
}

V3 acceleration_gravitation(double et, const double* r) {
    V6 m = etat_lune(et);
    V3 moon{m[0], m[1], m[2]};
    return gravite(r, moon, position_soleil(et));
}

Vec dynamique_libre(double et, const Vec& y) {
    V3 a = acceleration_gravitation(et, y.data());
    return {y[3], y[4], y[5], a[0], a[1], a[2]};
}

double collision_terre(double, const Vec& y) { return norme(y.data()) - R_EARTH; }

V3 rotation(const V3& v, const V3& axe, double angle) {
    V3 k = unitaire(axe);
    V3 kv = cross(k, v);
    double c = std::cos(angle), s = std::sin(angle);
    double d = dot3(k.data(), v.data());
    V3 out;
    for (int i = 0; i < 3; ++i) out[i] = (v[i] * c + kv[i] * s) + k[i] * d * (1 - c);
    return out;
}

double stumpff_c(double z) {
    if (z > 0) {
        double s = std::sqrt(z);
        return (1 - std::cos(s)) / z;
    }
    if (z < 0) {
        double s = std::sqrt(-z);
        return (std::cosh(s) - 1) / (-z);
    }
    return 0.5;
}

double stumpff_s(double z) {
    if (z > 0) {
        double s = std::sqrt(z);
        return (s - std::sin(s)) / pypow(s, 3);
    }
    if (z < 0) {
        double s = std::sqrt(-z);
        return (std::sinh(s) - s) / pypow(s, 3);
    }
    return 1.0 / 6;
}

V3 lambert(const V3& r1, const V3& r2, double duree_s, double mu, const V3& normale) {
    double n1 = norme(r1), n2 = norme(r2);
    double cos_angle = clip(dot3(r1.data(), r2.data()) / (n1 * n2), -1., 1.);
    double theta = std::acos(cos_angle);
    V3 c12 = cross(r1, r2);
    if (dot3(c12.data(), normale.data()) < 0) theta = 2 * PI - theta;
    double A = std::sin(theta) * std::sqrt(n1 * n2 / (1 - std::cos(theta)));
    if (std::fabs(A) < 1e-8) throw std::runtime_error("Lambert mal conditionne (angle proche de 0 ou 180 deg).");
    auto y = [&](double z) { return n1 + n2 + A * (z * stumpff_s(z) - 1) / std::sqrt(stumpff_c(z)); };
    auto F = [&](double z) {
        double yc = y(z);
        if (yc <= 0) return std::nan("");
        return pypow(yc / stumpff_c(z), 1.5) * stumpff_s(z) + A * std::sqrt(yc) - std::sqrt(mu) * duree_s;
    };
    Vec zs = linspace(-60., 4 * pypow(PI, 2) - 1e-5, 1600);
    bool have_prev = false;
    double pz = 0, pf = 0;
    std::optional<double> zsol;
    for (double z : zs) {
        double fz = F(z);
        if (!std::isfinite(fz)) continue;
        if (have_prev && pf * fz < 0) {
            zsol = brentq(F, pz, z);
            break;
        }
        have_prev = true;
        pz = z;
        pf = fz;
    }
    if (!zsol) throw std::runtime_error("Lambert : aucun intervalle de solution pour ce transfert.");
    double yy = y(*zsol);
    double f = 1 - yy / n1;
    double g = A * std::sqrt(yy / mu);
    return {(r2[0] - f * r1[0]) / g, (r2[1] - f * r1[1]) / g, (r2[2] - f * r1[2]) / g};
}

V6 etat_lunaire_moon_me(double et, const double* y) {
    V6 lj = etat_lune(et);
    double m[6][6];
    sxform("J2000", "MOON_ME", et, m);
    double d[6];
    for (int i = 0; i < 6; ++i) d[i] = y[i] - lj[i];
    auto r = matvec6(m, d);
    V6 out;
    std::copy(r.begin(), r.end(), out.begin());
    return out;
}

struct Bilan {
    double altitude_sur_site_km;
    double seuil_freinage_km;
    double distance_min_freinage_km;
    double vitesse_lunaire_ms;
    double vitesse_verticale_ms;
    double vitesse_horizontale_ms;
    double deceleration_initiale_ms2;
    double marge;
    json to_json() const {
        json j;
        j["altitude_sur_site_km"] = altitude_sur_site_km;
        j["seuil_freinage_km"] = seuil_freinage_km;
        j["distance_min_freinage_km"] = distance_min_freinage_km;
        j["vitesse_lunaire_ms"] = vitesse_lunaire_ms;
        j["vitesse_verticale_ms"] = vitesse_verticale_ms;
        j["vitesse_horizontale_ms"] = vitesse_horizontale_ms;
        j["deceleration_initiale_ms2"] = deceleration_initiale_ms2;
        j["marge"] = marge;
        j["altitude_reference"] = "rayon spherique du site (R_LUNE + altitude_site)";
        return j;
    }
};

Bilan bilan_freinage(double et, const double* y, const V3& site_me, double masse_kg = MASSE_INITIALE_KG,
                     double poussee_n = POUSSEE_MAX_N, double marge = MARGE_FREINAGE) {
    V6 l = etat_lunaire_moon_me(et, y);
    const double* r = l.data();
    const double* v = l.data() + 3;
    double distance_centre = norme(r);
    double rayon_site = norme(site_me);
    double grav = 1000.0 * GM_MOON / pypow(distance_centre, 2);
    double decel = poussee_n / masse_kg - grav;
    double vitesse_ms = 1000.0 * norme(v);
    V3 ru{r[0] / distance_centre, r[1] / distance_centre, r[2] / distance_centre};
    double vr = dot3(v, ru.data());
    double vitesse_radiale_ms = 1000.0 * vr;
    V3 h;
    for (int i = 0; i < 3; ++i) h[i] = v[i] - vr * r[i] / distance_centre;
    double vitesse_horiz_ms = 1000.0 * norme(h);
    double distance_m;
    if (decel <= 0)
        distance_m = INF;
    else
        distance_m = py_max(0.0, pypow(vitesse_ms, 2) - pypow(VITESSE_CONTACT_MS, 2)) / (2 * decel);
    return {distance_centre - rayon_site, marge * distance_m / 1000.0, distance_m / 1000.0, vitesse_ms,
            vitesse_radiale_ms, vitesse_horiz_ms, decel, marge};
}

struct EphemeridesRapides {
    CubicSpline moon;
    CubicSpline sun;

    EphemeridesRapides(double t0, double t1, double pas_s = 10800.0) {
        Vec t = linspace(t0, t1, static_cast<long>(std::ceil((t1 - t0) / pas_s)) + 1);
        std::vector<Vec> m, s;
        for (double x : t) {
            V6 a = etat_lune(x);
            m.emplace_back(a.begin(), a.end());
            V3 b = position_soleil(x);
            s.emplace_back(b.begin(), b.end());
        }
        moon = CubicSpline(t, m);
        sun = CubicSpline(t, s);
    }

    V3 acceleration(double t, const double* r) const {
        Vec l = moon(t);
        Vec so = sun(t);
        return gravite(r, V3{l[0], l[1], l[2]}, V3{so[0], so[1], so[2]});
    }

    IvpResult propager(double t0, double et_fin, const V3& r0, const V3& v0) const {
        Rhs derivee = [this](double t, const Vec& y) {
            V3 a = acceleration(t, y.data());
            return Vec{y[3], y[4], y[5], a[0], a[1], a[2]};
        };
        Event impact_terre{[](double, const Vec& y) { return norme(y.data()) - R_EARTH; }, true, -1};
        Event impact_lune{[this](double t, const Vec& y) {
                              Vec l = moon(t);
                              double d[3] = {y[0] - l[0], y[1] - l[1], y[2] - l[2]};
                              return norme(d) - R_MOON;
                          },
                          true, -1};
        IvpOptions o;
        o.rtol = 8e-7;
        o.atol = 1e-6;
        o.max_step = 18000.0;
        Vec y0{r0[0], r0[1], r0[2], v0[0], v0[1], v0[2]};
        return solve_ivp_dop853(derivee, t0, et_fin, y0, o, {impact_terre, impact_lune});
    }
};

V3 position_depart_imposee(double et_depart, double altitude_depart_km, double angle_depart_deg) {
    V6 lune = etat_lune(et_depart);
    V3 lr{lune[0], lune[1], lune[2]}, lv{lune[3], lune[4], lune[5]};
    V3 n = cross(lr, lv);
    if (norme(n) < 1e-9) n = cross(lr, V3{0.0, 0.0, 1.0});
    V3 r0 = rotation(unitaire(lr), n, -radians(angle_depart_deg));
    V3 u = unitaire(r0);
    double k = R_EARTH + altitude_depart_km;
    return {k * u[0], k * u[1], k * u[2]};
}

std::array<double, 2> direction_ra_dec(const V3& v) {
    V3 u = unitaire(v);
    return {std::atan2(u[1], u[0]), std::asin(clip(u[2], -1., 1.))};
}

V3 vitesse_ra_dec(double ra, double dec, double vk) {
    return {vk * (std::cos(dec) * std::cos(ra)), vk * (std::cos(dec) * std::sin(ra)), vk * std::sin(dec)};
}

std::string pyrepr(double v) {
    if (std::isnan(v)) return "NaN";
    if (std::isinf(v)) return v > 0 ? "Infinity" : "-Infinity";
    if (v == 0) return std::signbit(v) ? "-0.0" : "0.0";
    char buf[64];
    auto res = std::to_chars(buf, buf + sizeof buf, v, std::chars_format::scientific);
    std::string s(buf, res.ptr);
    bool neg = s[0] == '-';
    if (neg) s = s.substr(1);
    std::size_t e = s.find('e');
    int exp10 = std::stoi(s.substr(e + 1));
    std::string mant = s.substr(0, e);
    std::string digits;
    for (char c : mant)
        if (c != '.') digits += c;
    std::string out;
    if (exp10 >= -4 && exp10 < 16) {
        int nd = static_cast<int>(digits.size());
        if (exp10 >= 0) {
            if (nd <= exp10 + 1) {
                out = digits + std::string(exp10 + 1 - nd, '0') + ".0";
            } else {
                out = digits.substr(0, exp10 + 1) + "." + digits.substr(exp10 + 1);
            }
        } else {
            out = "0." + std::string(-exp10 - 1, '0') + digits;
        }
    } else {
        out = digits.substr(0, 1);
        if (digits.size() > 1) out += "." + digits.substr(1);
        char eb[16];
        std::snprintf(eb, sizeof eb, "e%c%02d", exp10 < 0 ? '-' : '+', std::abs(exp10));
        out += eb;
    }
    return neg ? "-" + out : out;
}

std::string json_string(const std::string& s) {
    std::string o = "\"";
    for (unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            case '\b': o += "\\b"; break;
            case '\f': o += "\\f"; break;
            default:
                if (c < 0x20) {
                    char b[8];
                    std::snprintf(b, sizeof b, "\\u%04x", c);
                    o += b;
                } else {
                    o += static_cast<char>(c);
                }
        }
    }
    return o + "\"";
}

void pyjson(const json& j, std::string& out, int level) {
    std::string ind(2 * (level + 1), ' '), ind0(2 * level, ' ');
    switch (j.type()) {
        case json::value_t::object: {
            if (j.empty()) {
                out += "{}";
                return;
            }
            out += "{\n";
            bool first = true;
            for (auto it = j.begin(); it != j.end(); ++it) {
                if (!first) out += ",\n";
                first = false;
                out += ind + json_string(it.key()) + ": ";
                pyjson(it.value(), out, level + 1);
            }
            out += "\n" + ind0 + "}";
            return;
        }
        case json::value_t::array: {
            if (j.empty()) {
                out += "[]";
                return;
            }
            out += "[\n";
            bool first = true;
            for (const auto& v : j) {
                if (!first) out += ",\n";
                first = false;
                out += ind;
                pyjson(v, out, level + 1);
            }
            out += "\n" + ind0 + "]";
            return;
        }
        case json::value_t::string: out += json_string(j.get<std::string>()); return;
        case json::value_t::boolean: out += j.get<bool>() ? "true" : "false"; return;
        case json::value_t::null: out += "null"; return;
        case json::value_t::number_float: out += pyrepr(j.get<double>()); return;
        case json::value_t::number_integer: out += std::to_string(j.get<long long>()); return;
        case json::value_t::number_unsigned: out += std::to_string(j.get<unsigned long long>()); return;
        default: throw std::runtime_error("type JSON non gere");
    }
}

void write_json(const fs::path& p, const json& j) {
    std::string s;
    pyjson(j, s, 0);
    std::ofstream f(p, std::ios::binary);
    f << s;
    if (!f) throw std::runtime_error("Ecriture impossible : " + p.string());
}

struct CsvWriter {
    std::ofstream f;
    explicit CsvWriter(const fs::path& p) : f(p, std::ios::binary) {
        if (!f) throw std::runtime_error("Ecriture impossible : " + p.string());
        f << "\xEF\xBB\xBF";
    }
    void row(const std::vector<std::string>& cells) {
        for (std::size_t i = 0; i < cells.size(); ++i) {
            if (i) f << ';';
            f << cells[i];
        }
        f << "\r\n";
    }
};

std::string fmt(const char* spec, double v) {
    char b[64];
    std::snprintf(b, sizeof b, spec, v);
    return b;
}

std::string fmt_g(double v) {
    std::ostringstream o;
    o << pyrepr(v);
    return o.str();
}

struct Diagnostic {
    std::string statut;
    IvpResult sol;
    V3 r0, v0;
    double erreur_guide_km;
    double t_min;
    Bilan critere_min;
    double laterale_min_km;
    bool has_transition = false;
    double t_transition = 0;
    Vec etat_transition;
    Bilan critere_transition{};
    double laterale_transition_km = 0;
    double lateral_max_km = 0;
};

class Trajectoire {
public:
    double latitude, longitude, altitude_site;
    std::string date_utc;
    double duree_jours, altitude_approche, angle_depart, max_attente_h, vitesse_depart, altitude_depart;
    int nb_essais;
    double demi_fenetre;
    V3 site;
    double t0 = 0;
    std::optional<Diagnostic> meilleur;
    std::optional<json> transition;
    std::optional<json> diagnostic;

    Trajectoire(double lat, double lon, double alt_site, std::string date, double duree, double alt_approche,
                double angle, double max_attente, double vitesse, double alt_depart, int essais, double demi)
        : latitude(lat), longitude(lon), altitude_site(alt_site), date_utc(std::move(date)), duree_jours(duree),
          altitude_approche(alt_approche), angle_depart(angle), max_attente_h(max_attente), vitesse_depart(vitesse),
          altitude_depart(alt_depart), nb_essais(essais), demi_fenetre(demi),
          site(site_moon_me(lat, lon, alt_site)) {}

    struct Candidats {
        std::vector<std::pair<double, Vec>> liste;
        double target_h;
    };

    Candidats optimiser_candidats(double tt0, const V3& r0) {
        double bas = py_max(1.5, duree_jours - demi_fenetre);
        double haut = py_min(12., duree_jours + demi_fenetre);
        if (bas >= haut) throw ValueError("Fenetre de temps de transfert vide");
        EphemeridesRapides interpol(tt0, tt0 + (haut + 1.0) * 86400.0);
        V3 r_site = unitaire(site);
        double target_h = py_max(250.0, py_min(1500.0, altitude_approche / 5.0));
        double rk = norme(site) + target_h;
        V3 point{r_site[0] * rk, r_site[1] * rk, r_site[2] * rk};
        Vec plage = linspace(bas, haut, 7);
        std::vector<Vec> v_seeds;
        for (double jours : plage) {
            double t = tt0 + jours * 86400.0;
            V6 cs = etat_site(t, point);
            V3 cible{cs[0], cs[1], cs[2]};
            V6 lune = etat_lune(t);
            V3 normale = cross(V3{lune[0], lune[1], lune[2]}, V3{lune[3], lune[4], lune[5]});
            for (const V3& n : {normale, V3{-normale[0], -normale[1], -normale[2]}}) {
                try {
                    V3 v = lambert(r0, cible, jours * 86400., GM_EARTH, n);
                    if (std::isfinite(v[0]) && std::isfinite(v[1]) && std::isfinite(v[2]) && norme(v) > 0) {
                        auto rd = direction_ra_dec(v);
                        v_seeds.push_back({rd[0], rd[1], jours});
                    }
                } catch (const std::invalid_argument&) {
                } catch (const std::runtime_error&) {
                }
            }
        }
        if (v_seeds.empty()) {
            double rs = norme(site);
            V6 ts = etat_site(tt0 + duree_jours * 86400., V3{r_site[0] * rs, r_site[1] * rs, r_site[2] * rs});
            auto rd = direction_ra_dec(sub3(ts.data(), r0.data()));
            v_seeds.push_back({rd[0], rd[1], duree_jours});
        }
        auto residu = [&](const Vec& x) -> Vec {
            double ra = x[0], dec = x[1], jours = x[2];
            double arrivee = tt0 + jours * 86400.0;
            V3 v0 = vitesse_ra_dec(ra, dec, vitesse_depart);
            IvpResult sol = interpol.propager(tt0, arrivee, r0, v0);
            V6 cs = etat_site(arrivee, point);
            const Vec& yl = sol.y.back();
            if (!sol.success || sol.t.back() < arrivee - 2.) {
                V3 manque{(yl[0] - cs[0]) / 1000.0, (yl[1] - cs[1]) / 1000.0, (yl[2] - cs[2]) / 1000.0};
                if (norme(manque) > 1e-12) {
                    V3 u = unitaire(manque);
                    return {manque[0] + 500.0 * u[0], manque[1] + 500.0 * u[1], manque[2] + 500.0 * u[2]};
                }
                return {500.0, 500.0, 500.0};
            }
            return {(yl[0] - cs[0]) / 1000.0, (yl[1] - cs[1]) / 1000.0, (yl[2] - cs[2]) / 1000.0};
        };
        std::vector<std::pair<double, Vec>> graines;
        for (const Vec& x : v_seeds) {
            try {
                Vec r = residu(x);
                double e = npnorm(r);
                if (std::isfinite(e)) graines.push_back({e, x});
            } catch (const std::invalid_argument&) {
                continue;
            } catch (const std::runtime_error&) {
                continue;
            }
        }
        if (graines.empty()) throw std::runtime_error("Aucune amorce de transfert n'a pu etre propagee");
        std::stable_sort(graines.begin(), graines.end(),
                         [](const auto& a, const auto& b) { return a.first < b.first; });
        std::vector<Vec> choisies;
        for (const auto& [score, x] : graines) {
            bool ok = true;
            for (const Vec& autre : choisies)
                if (!(std::fabs(x[2] - autre[2]) > 0.4)) ok = false;
            if (ok) choisies.push_back(x);
            if (static_cast<int>(choisies.size()) >= nb_essais) break;
        }
        std::vector<std::pair<double, Vec>> candidats;
        LsqOptions o;
        o.lb = {-4 * PI, -PI / 2 + 1e-5, bas};
        o.ub = {4 * PI, PI / 2 - 1e-5, haut};
        o.max_nfev = 32;
        o.ftol = o.xtol = o.gtol = 1e-7;
        o.x_scale = {1., 0.5, 1.};
        o.diff_step = 1e-5;
        for (std::size_t i = 0; i < choisies.size(); ++i) {
            const Vec& x0 = choisies[i];
            std::printf("[RECHERCHE] Amorce %zu/%zu : %.2f jours\n", i + 1, choisies.size(), x0[2]);
            std::fflush(stdout);
            try {
                LsqResult opt = least_squares(residu, x0, o);
                double err = npnorm(residu(opt.x)) * 1000.0;
                candidats.push_back({err, opt.x});
                std::printf("  Ecart au point-guide (approx.) : %.1f km\n", err);
            } catch (const std::invalid_argument& exc) {
                std::printf("  Recherche impossible pour cette amorce : %s\n", exc.what());
            } catch (const std::runtime_error& exc) {
                std::printf("  Recherche impossible pour cette amorce : %s\n", exc.what());
            }
            std::fflush(stdout);
        }
        if (candidats.empty()) throw std::runtime_error("Optimisation numerique echouee pour toutes les amorces");
        std::stable_sort(candidats.begin(), candidats.end(),
                         [](const auto& a, const auto& b) { return a.first < b.first; });
        return {candidats, target_h};
    }

    Diagnostic propager_et_diagnostiquer(double tt0, const V3& r0, const Vec& x, double erreur_guide_km) {
        double ra = x[0], dec = x[1], jours = x[2];
        V3 v0 = vitesse_ra_dec(ra, dec, vitesse_depart);
        double fin = tt0 + py_min(13.0, py_max(jours, duree_jours + demi_fenetre) + max_attente_h / 24.0) * 86400.0;
        auto seuil = [this](double t, const Vec& y) {
            Bilan c = bilan_freinage(t, y.data(), site);
            return c.altitude_sur_site_km - c.seuil_freinage_km;
        };
        auto pericentre = [](double t, const Vec& y) {
            V6 lune = etat_lune(t);
            V3 d = sub3(y.data(), lune.data());
            V3 dv = sub3(y.data() + 3, lune.data() + 3);
            return dot3(d.data(), dv.data()) / norme(d);
        };
        double rs = norme(site);
        auto contact = [rs](double t, const Vec& y) {
            V6 l = etat_lune(t);
            V3 d = sub3(y.data(), l.data());
            return norme(d) - rs;
        };
        Vec etat0{r0[0], r0[1], r0[2], v0[0], v0[1], v0[2]};
        IvpOptions o;
        o.rtol = 2e-9;
        o.atol = 1e-8;
        o.max_step = 3600.0;
        o.dense_output = true;
        IvpResult sol = solve_ivp_dop853(dynamique_libre, tt0, fin, etat0, o,
                                         {{seuil, true, -1}, {pericentre, false, 1}, {contact, true, -1},
                                          {collision_terre, true, -1}});
        if (!sol.success) throw std::runtime_error("Propagation SPICE : " + sol.message);
        Vec instants = linspace(tt0, sol.t.back(), 250);
        if (!sol.t_events[1].empty()) {
            instants.insert(instants.end(), sol.t_events[1].begin(), sol.t_events[1].end());
            std::sort(instants.begin(), instants.end());
        }
        const OdeSolution& ds = *sol.sol;
        auto dist_lune = [&](double t) {
            Vec y = ds(t);
            V6 l = etat_lune(t);
            V3 d = sub3(y.data(), l.data());
            return norme(d);
        };
        std::size_t ix = 0;
        double best = 0;
        for (std::size_t i = 0; i < instants.size(); ++i) {
            double d = dist_lune(instants[i]);
            if (i == 0 || (!std::isnan(best) && (std::isnan(d) || d < best))) {
                best = d;
                ix = i;
            }
        }
        double t_min = instants[ix];
        if (0 < ix && ix < instants.size() - 1) {
            double lo = py_min(instants[ix - 1], instants[ix + 1]);
            double hi = py_max(instants[ix - 1], instants[ix + 1]);
            if (hi > lo) {
                ScalarMinResult refine = minimize_scalar_bounded(dist_lune, lo, hi);
                if (refine.success) t_min = refine.x;
            }
        }
        Vec ymin = ds(t_min);
        Diagnostic dg;
        dg.critere_min = bilan_freinage(t_min, ymin.data(), site);
        V6 pm = etat_lunaire_moon_me(t_min, ymin.data());
        V3 us = unitaire(site);
        double angular = std::acos(clip(dot3(unitaire(V3{pm[0], pm[1], pm[2]}).data(), us.data()), -1., 1.));
        dg.laterale_min_km = norme(site) * angular;
        if (!sol.t_events[0].empty()) {
            double t_tr = sol.t_events[0][0];
            Vec ytr = sol.y_events[0][0];
            Bilan ct = bilan_freinage(t_tr, ytr.data(), site);
            V6 pme = etat_lunaire_moon_me(t_tr, ytr.data());
            double ang = std::acos(clip(dot3(unitaire(V3{pme[0], pme[1], pme[2]}).data(), us.data()), -1., 1.));
            double lat = norme(site) * ang;
            double lateral_max = py_max(25.0, 0.5 * ct.seuil_freinage_km);
            dg.statut = (lat <= lateral_max && ct.vitesse_verticale_ms < 0) ? "TRANSITION_ATTEINTE"
                                                                             : "SEUIL_ATTEINT_MAIS_SITE_TROP_ELOIGNE";
            dg.has_transition = true;
            dg.t_transition = t_tr;
            dg.etat_transition = ytr;
            dg.critere_transition = ct;
            dg.laterale_transition_km = lat;
            dg.lateral_max_km = lateral_max;
        } else if (seuil(tt0, etat0) <= 0) {
            dg.statut = "SEUIL_DEPASSE_DES_LE_DEPART";
        } else if (!sol.t_events[2].empty()) {
            dg.statut = "CONTACT_SANS_TRANSITION";
        } else if (!sol.t_events[3].empty()) {
            dg.statut = "COLLISION_TERRE";
        } else {
            dg.statut = "SURVOL_SANS_SEUIL";
        }
        dg.sol = std::move(sol);
        dg.r0 = r0;
        dg.v0 = v0;
        dg.erreur_guide_km = erreur_guide_km;
        dg.t_min = t_min;
        return dg;
    }

    json executer() {
        if (duree_jours <= 0 || vitesse_depart <= 0 || altitude_depart <= 0 || altitude_approche <= 0 || nb_essais < 1 ||
            nb_essais > 10 || demi_fenetre <= 0 || max_attente_h <= 0)
            throw ValueError("Parametres de transfert invalides");
        t0 = str2et(date_utc);
        V3 r0 = position_depart_imposee(t0, altitude_depart, angle_depart);
        Candidats cands = optimiser_candidats(t0, r0);
        std::vector<Diagnostic> essais;
        for (std::size_t i = 0; i < cands.liste.size(); ++i) {
            const auto& [err, x] = cands.liste[i];
            std::printf("[VALIDATION SPICE] Candidat %zu/%zu, erreur geometrie rapide : %.1f km\n", i + 1,
                        cands.liste.size(), err);
            std::fflush(stdout);
            Diagnostic item;
            try {
                item = propager_et_diagnostiquer(t0, r0, x, err);
            } catch (const std::invalid_argument& exc) {
                std::printf("  Propagation impossible : %s\n", exc.what());
                continue;
            } catch (const std::runtime_error& exc) {
                std::printf("  Propagation impossible : %s\n", exc.what());
                continue;
            }
            essais.push_back(item);
            std::printf("  %s | altitude mini : %.1f km | ecart site : %.1f km\n", item.statut.c_str(),
                        item.critere_min.altitude_sur_site_km, item.laterale_min_km);
            std::fflush(stdout);
            if (item.statut == "TRANSITION_ATTEINTE") break;
        }
        if (essais.empty()) throw std::runtime_error("Aucun transfert valide apres verification SPICE");
        std::optional<std::size_t> ib;
        for (std::size_t i = 0; i < essais.size(); ++i)
            if (essais[i].statut == "TRANSITION_ATTEINTE" &&
                (!ib || essais[i].laterale_transition_km < essais[*ib].laterale_transition_km))
                ib = i;
        if (!ib) {
            auto score = [](const Diagnostic& a) {
                return py_max(0., a.critere_min.altitude_sur_site_km - a.critere_min.seuil_freinage_km) +
                       a.laterale_min_km;
            };
            ib = 0;
            for (std::size_t i = 1; i < essais.size(); ++i)
                if (score(essais[i]) < score(essais[*ib])) ib = i;
        }
        meilleur = essais[*ib];
        const Diagnostic& m = *meilleur;
        if (m.statut != "TRANSITION_ATTEINTE") {
            const Bilan& c = m.critere_min;
            json d;
            d["statut"] = m.statut;
            d["instant_utc_minimum"] = et2utc(m.t_min) + "Z";
            d["altitude_minimale_km"] = c.altitude_sur_site_km;
            d["seuil_a_cet_instant_km"] = c.seuil_freinage_km;
            d["vitesse_lunaire_ms"] = c.vitesse_lunaire_ms;
            d["distance_laterale_site_km"] = m.laterale_min_km;
            d["ecart_point_approche_km"] = m.erreur_guide_km;
            d["vitesse_depart_km_s"] = vitesse_depart;
            d["altitude_depart_km"] = altitude_depart;
            d["angle_depart_deg"] = angle_depart;
            d["nombre_candidats_controles"] = static_cast<long long>(essais.size());
            d["commentaire"] =
                "Aucun etat de transition admissible trouve; cela ne demontre pas une impossibilite globale. "
                "Elargir la fenetre temporelle / les amorces si necessaire.";
            diagnostic = d;
            return d;
        }
        double t = m.t_transition;
        const Vec& y = m.etat_transition;
        V6 rv = etat_lunaire_moon_me(t, y.data());
        double reserve = ISP_S * G0_M_S2 * std::log(MASSE_INITIALE_KG / MASSE_SECHE_KG);
        json tr;
        tr["statut"] = "TRANSITION_ATTEINTE";
        tr["instant_utc"] = et2utc(t) + "Z";
        tr["et_tdb_s"] = t;
        tr["repere_etat"] = "J2000 geocentrique, km et km/s";
        tr["position_j2000_km"] = {y[0], y[1], y[2]};
        tr["vitesse_j2000_km_s"] = {y[3], y[4], y[5]};
        tr["position_moon_me_km"] = {rv[0], rv[1], rv[2]};
        tr["vitesse_moon_me_km_s"] = {rv[3], rv[4], rv[5]};
        json s;
        s["latitude_deg"] = latitude;
        s["longitude_est_deg"] = longitude;
        s["altitude_site_km"] = altitude_site;
        tr["site"] = s;
        json v;
        v["masse_kg"] = MASSE_INITIALE_KG;
        v["carburant_kg"] = CARBURANT_INITIAL_KG;
        v["masse_seche_kg"] = MASSE_SECHE_KG;
        v["poussee_max_n"] = POUSSEE_MAX_N;
        v["isp_s"] = ISP_S;
        v["carburant_illimite"] = CARBURANT_ILLIMITE;
        v["modele_masse"] = CARBURANT_ILLIMITE ? "constante avec ravitaillement fictif" : "masse variable";
        tr["vehicule"] = v;
        tr["critere"] = m.critere_transition.to_json();
        tr["distance_laterale_site_km"] = m.laterale_transition_km;
        tr["distance_laterale_admise_km"] = m.lateral_max_km;
        tr["delta_v_theorique_reservoir_nominal_ms"] = reserve;
        tr["delta_v_ideal_disponible_ms"] = CARBURANT_ILLIMITE ? json(nullptr) : json(reserve);
        tr["vitesse_depart_km_s"] = vitesse_depart;
        tr["altitude_depart_km"] = altitude_depart;
        tr["angle_depart_deg"] = angle_depart;
        tr["nombre_candidats_controles"] = static_cast<long long>(essais.size());
        tr["commentaire"] =
            "Seuil de freinage 1D, sans preuve de faisabilite 3D. Les ergols illimites sont fictifs; la poussee reste "
            "limitee.";
        transition = tr;
        return tr;
    }

    std::pair<fs::path, fs::path> exporter(const fs::path& dossier) {
        if (!meilleur) throw std::runtime_error("Executer la trajectoire avant export");
        fs::create_directories(dossier);
        fs::path json_f = dossier / (transition ? "etat_debut_alunissage.json" : "diagnostic_trajectoire.json");
        fs::path csv_f = dossier / "trajectoire_avant_alunissage.csv";
        write_json(json_f, transition ? *transition : *diagnostic);
        const IvpResult& sol = meilleur->sol;
        double fin = sol.t.back();
        if (transition) fin = (*transition)["et_tdb_s"].get<double>();
        CsvWriter w(csv_f);
        w.row({"date_utc", "phase", "x_j2000_km", "y_j2000_km", "z_j2000_km", "vx_kms", "vy_kms", "vz_kms",
               "altitude_site_spherique_km", "vitesse_lunaire_ms", "masse_kg", "carburant_kg"});
        for (double t : linspace(t0, fin, 900)) {
            Vec y = (*sol.sol)(t);
            V6 lune = etat_lune(t);
            double altitude = norme(sub3(y.data(), lune.data())) - norme(site);
            double vitesse = 1000. * norme(sub3(y.data() + 3, lune.data() + 3));
            std::vector<std::string> row{et2utc(t), "TRANSFERT_LIBRE"};
            for (int i = 0; i < 6; ++i) row.push_back(pyrepr(y[i]));
            row.push_back(pyrepr(altitude));
            row.push_back(pyrepr(vitesse));
            row.push_back(pyrepr(MASSE_INITIALE_KG));
            row.push_back(pyrepr(CARBURANT_INITIAL_KG));
            w.row(row);
        }
        return {csv_f, json_f};
    }
};

class Alunissage {
public:
    fs::path fichier;
    double duree_max_s, distance_max_contact_m, vitesse_max_contact_ms;
    double poussee_max = 0, isp = 0, masse_seche = 0, masse_initiale = 0, carburant_nominal = 0;
    bool carburant_illimite = CARBURANT_ILLIMITE;
    double t0 = 0;
    Vec y0;
    V3 site{};
    json entree;
    std::optional<IvpResult> solution;
    json bilan;

    Alunissage(fs::path f, double duree, double dmax = 100.0, double vmax = VITESSE_CONTACT_MS)
        : fichier(std::move(f)), duree_max_s(duree), distance_max_contact_m(dmax), vitesse_max_contact_ms(vmax) {
        if (duree_max_s <= 0) throw ValueError("Duree de descente positive obligatoire");
    }

    void charger_etat() {
        if (!fs::is_regular_file(fichier))
            throw std::runtime_error("Etat initial absent : " + fichier.string() +
                                     ". Executer d'abord la trajectoire.");
        std::ifstream in(fichier, std::ios::binary);
        std::stringstream ss;
        ss << in.rdbuf();
        entree = json::parse(ss.str());
        if (!entree.contains("statut") || entree["statut"] != "TRANSITION_ATTEINTE")
            throw ValueError("Le fichier JSON ne contient pas de transition valide");
        const json& engin = entree["vehicule"];
        double masse = engin["masse_kg"].get<double>();
        double sec = engin["masse_seche_kg"].get<double>();
        double carb = engin["carburant_kg"].get<double>();
        poussee_max = engin["poussee_max_n"].get<double>();
        isp = engin["isp_s"].get<double>();
        if (masse <= sec || sec <= 0 || carb <= 0 || poussee_max <= 0 || isp <= 0 || std::fabs((masse - sec) - carb) > 1e-5)
            throw ValueError("Masse, carburant ou caracteristiques moteur incoherents");
        masse_seche = sec;
        masse_initiale = masse;
        carburant_nominal = carb;
        carburant_illimite = engin.contains("carburant_illimite") ? engin["carburant_illimite"].get<bool>()
                                                                  : CARBURANT_ILLIMITE;
        t0 = entree["et_tdb_s"].get<double>();
        Vec y;
        for (const auto& v : entree["position_j2000_km"]) y.push_back(v.get<double>());
        for (const auto& v : entree["vitesse_j2000_km_s"]) y.push_back(v.get<double>());
        bool finite = std::isfinite(t0);
        for (double v : y) finite = finite && std::isfinite(v);
        if (y.size() != 6 || !finite) throw ValueError("Etat spatial initial invalide");
        const json& s = entree["site"];
        site = site_moon_me(s["latitude_deg"].get<double>(), s["longitude_est_deg"].get<double>(),
                            s["altitude_site_km"].get<double>());
        y0 = y;
        y0.push_back(masse);
        y0.push_back(0.);
        y0.push_back(0.);
    }

    struct Commande {
        V3 a_moteur;
        double poussee;
        double demande_ms2;
    };

    Commande commande(double t, const Vec& y) const {
        if (!carburant_illimite && y[6] <= masse_seche + 1e-8) return {{0, 0, 0}, 0.0, 0.0};
        V6 lune = etat_lune(t);
        V3 rel_r = sub3(y.data(), lune.data());
        V3 radial = unitaire(rel_r);
        double distance = norme(rel_r);
        double altitude_km = py_max(0.0, distance - norme(site));
        V3 rel_v = sub3(y.data() + 3, lune.data() + 3);
        double v_rad = dot3(rel_v.data(), radial.data());
        V3 v_tan;
        for (int i = 0; i < 3; ++i) v_tan[i] = rel_v[i] - v_rad * radial[i];
        V6 sol = etat_site(t, site);
        V3 p_err = sub3(sol.data(), y.data());
        double pe = dot3(p_err.data(), radial.data());
        V3 err_tan;
        for (int i = 0; i < 3; ++i) err_tan[i] = p_err[i] - pe * radial[i];
        V3 v_sol_rel = sub3(sol.data() + 3, lune.data() + 3);
        double vs = dot3(v_sol_rel.data(), radial.data());
        V3 v_sol_tan;
        for (int i = 0; i < 3; ++i) v_sol_tan[i] = v_sol_rel[i] - vs * radial[i];
        double tau = clip(2.0 * altitude_km / py_max(0.05, -v_rad), 40.0, 1600.0);
        double vf = 0.25 * vitesse_max_contact_ms / 1000.0;
        double acc_rad;
        if (v_rad < 0)
            acc_rad = py_max(0.0, (pypow(v_rad, 2) - pypow(vf, 2)) / (2.0 * py_max(0.01, altitude_km)));
        else
            acc_rad = -v_rad / py_max(40.0, tau);
        double grav = 1000.0 * GM_MOON / pypow(distance, 2);
        double accel_dispo = py_max(0.05, poussee_max / y[6] - grav);
        double vmin_desc_ms =
            py_max(0.4, py_min(100.0, 0.12 * std::sqrt(2.0 * accel_dispo * py_max(altitude_km, 0.0) * 1000.0)));
        double vmin_desc_kms = vmin_desc_ms / 1000.0;
        if (v_rad > -vmin_desc_kms)
            acc_rad = py_min(acc_rad, (-vmin_desc_kms - v_rad) / py_max(50.0, py_min(tau, 220.0)));
        double tau2 = pypow(tau, 2);
        V3 acc_voulue;
        for (int i = 0; i < 3; ++i) {
            double acc_tan = 2.0 * err_tan[i] / tau2 + 2.0 * (v_sol_tan[i] - v_tan[i]) / tau;
            acc_voulue[i] = acc_rad * radial[i] + acc_tan;
        }
        V3 g = acceleration_gravitation(t, y.data());
        V3 demande;
        for (int i = 0; i < 3; ++i) demande[i] = acc_voulue[i] - g[i];
        double demande_ms2 = 1000.0 * norme(demande);
        if (demande_ms2 <= 1e-12) return {{0, 0, 0}, 0.0, 0.0};
        double poussee = py_min(poussee_max, y[6] * demande_ms2);
        double k = poussee / (y[6] * demande_ms2);
        return {{demande[0] * k, demande[1] * k, demande[2] * k}, poussee, demande_ms2};
    }

    Vec derivee(double t, const Vec& y) const {
        Commande c = commande(t, y);
        double debit_ergols = c.poussee / (isp * G0_M_S2);
        double dm = carburant_illimite ? 0.0 : -debit_ergols;
        double dv = 1000.0 * norme(c.a_moteur);
        V3 g = acceleration_gravitation(t, y.data());
        return {y[3], y[4], y[5], g[0] + c.a_moteur[0], g[1] + c.a_moteur[1], g[2] + c.a_moteur[2], dm, dv,
                debit_ergols};
    }

    json executer() {
        charger_etat();
        V6 l0 = etat_lune(t0);
        if (norme(sub3(y0.data(), l0.data())) <= norme(site))
            throw std::runtime_error("Etat initial deja en contact avec le niveau spherique du site");
        double rs = norme(site);
        Event contact{[rs](double t, const Vec& y) {
                          V6 l = etat_lune(t);
                          return norme(sub3(y.data(), l.data())) - rs;
                      },
                      true, -1};
        double ms = masse_seche;
        Event carburant{[ms](double, const Vec& y) { return y[6] - ms; }, true, -1};
        std::vector<Event> evenements{contact};
        if (!carburant_illimite) evenements.push_back(carburant);
        IvpOptions o;
        o.rtol = 2e-8;
        o.atol = 1e-8;
        o.max_step = 4.0;
        o.dense_output = true;
        IvpResult sol = solve_ivp_dop853([this](double t, const Vec& y) { return derivee(t, y); }, t0,
                                         t0 + duree_max_s, y0, o, evenements);
        if (!sol.success) throw std::runtime_error("Echec de l'integration motorisee : " + sol.message);
        double fin = sol.t.back();
        const Vec& yf = sol.y.back();
        V6 me = etat_lunaire_moon_me(fin, yf.data());
        double vitesse_sol_ms = 1000.0 * norme(me.data() + 3);
        V3 radial_me = unitaire(V3{me[0], me[1], me[2]});
        double vr = dot3(me.data() + 3, radial_me.data());
        double v_rad_ms = 1000.0 * vr;
        V3 h;
        for (int i = 0; i < 3; ++i) h[i] = me[3 + i] - vr * radial_me[i];
        double v_horiz_ms = 1000.0 * norme(h);
        double separation_km = norme(sub3(me.data(), site.data()));
        double angle_site = std::acos(clip(dot3(radial_me.data(), unitaire(site).data()), -1.0, 1.0));
        double ecart_surface_km = norme(site) * angle_site;
        bool epuise = !carburant_illimite && sol.t_events.size() > 1 && !sol.t_events[1].empty();
        bool touche = !sol.t_events[0].empty();
        bool reussite = touche && !epuise && vitesse_sol_ms <= vitesse_max_contact_ms &&
                        separation_km * 1000 <= distance_max_contact_m;
        std::string statut = reussite ? "CONTACT_CONTROLE_MODELE_SPHERIQUE"
                             : epuise ? "CARBURANT_EPUISE"
                             : touche ? "CONTACT_NON_CONTROLE"
                                      : "AUCUN_CONTACT_DANS_LA_DUREE";
        double masse_reelle = py_max(masse_seche, yf[6]);
        double consomme_equivalent = yf[8];
        double carburant_restant = carburant_illimite ? carburant_nominal : py_max(0.0, masse_reelle - masse_seche);
        json b;
        b["statut"] = statut;
        b["instant_debut_utc"] = entree["instant_utc"];
        b["instant_fin_utc"] = et2utc(fin) + "Z";
        b["duree_s"] = fin - t0;
        b["duree_max_s"] = duree_max_s;
        b["contact_detecte"] = touche;
        b["vitesse_finale_lunaire_ms"] = vitesse_sol_ms;
        b["vitesse_verticale_finale_ms"] = v_rad_ms;
        b["vitesse_horizontale_finale_ms"] = v_horiz_ms;
        b["distance_site_finale_m"] = 1000 * separation_km;
        b["ecart_surface_site_final_km"] = ecart_surface_km;
        b["altitude_sur_site_finale_km"] = norme(me.data()) - norme(site);
        b["masse_initiale_kg"] = masse_initiale;
        b["masse_finale_kg"] = masse_reelle;
        b["masse_seche_kg"] = masse_seche;
        b["carburant_illimite"] = carburant_illimite;
        b["carburant_reservoir_reference_kg"] = carburant_nominal;
        b["carburant_restant_kg"] = carburant_restant;
        b["carburant_consomme_kg"] = consomme_equivalent;
        b["depassement_reservoir_kg"] = py_max(0.0, consomme_equivalent - carburant_nominal);
        b["reservoirs_equivalents_consomme"] = consomme_equivalent / carburant_nominal;
        b["delta_v_moteur_ms"] = yf[7];
        b["poussee_max_n"] = poussee_max;
        b["isp_s"] = isp;
        b["seuil_transition_km"] = entree["critere"]["seuil_freinage_km"];
        b["limite_modele"] = carburant_illimite ? "Ergols fictivement illimites, masse constante; guidage de "
                                                  "demonstration et sol spherique; ce resultat ne valide pas la "
                                                  "faisabilite reelle"
                                                : "Sol spherique et guidage de demonstration";
        solution = std::move(sol);
        bilan = b;
        return b;
    }

    std::pair<fs::path, fs::path> exporter(const fs::path& dossier) {
        if (!solution) throw std::runtime_error("Calculer la descente avant l'export");
        fs::create_directories(dossier);
        fs::path bilan_f = dossier / "bilan_alunissage.json";
        fs::path csv_f = dossier / "alunissage.csv";
        write_json(bilan_f, bilan);
        CsvWriter w(csv_f);
        w.row({"date_utc", "x_j2000_km", "y_j2000_km", "z_j2000_km", "vx_kms", "vy_kms", "vz_kms",
               "altitude_site_spherique_km", "vitesse_lunaire_ms", "masse_kg", "carburant_kg", "poussee_n",
               "acceleration_moteur_ms2", "delta_v_cumule_ms", "carburant_consomme_cumule_kg"});
        for (double t : linspace(t0, solution->t.back(), 500)) {
            Vec y = (*solution->sol)(t);
            V6 me = etat_lunaire_moon_me(t, y.data());
            Commande c = commande(t, y);
            std::vector<std::string> row{et2utc(t)};
            for (int i = 0; i < 6; ++i) row.push_back(pyrepr(y[i]));
            row.push_back(pyrepr(norme(me.data()) - norme(site)));
            row.push_back(pyrepr(1000 * norme(me.data() + 3)));
            row.push_back(pyrepr(y[6]));
            row.push_back(pyrepr(carburant_illimite ? carburant_nominal : py_max(0.0, y[6] - masse_seche)));
            row.push_back(pyrepr(c.poussee));
            row.push_back(pyrepr(1000 * norme(c.a_moteur)));
            row.push_back(pyrepr(y[7]));
            row.push_back(pyrepr(y[8]));
            w.row(row);
        }
        return {csv_f, bilan_f};
    }
};

struct Args {
    std::string phase = "trajectoire";
    double lat = -85.0;
    double lon = -30.0;
    double alt_site = 1.5;
    std::string date = "2027 JAN 01 00:00:00 UTC";
    double vitesse_depart = VITESSE_DEPART_FIXE_KMS;
    double alt_depart = ALTITUDE_DEPART_FIXE_KM;
    double angle = 170.0;
    double jours = 4.5;
    double fenetre_j = 2.0;
    int essais = 3;
    double max_attente_h = 24.0;
    double duree_descente_h = 2.0;
    fs::path sortie = ".";
};

bool simulation_trajectoire(const Args& a) {
    fs::path etat = a.sortie / "etat_debut_alunissage.json";
    if (fs::exists(etat)) fs::remove(etat);
    fs::path ancien = a.sortie / "diagnostic_trajectoire.json";
    if (fs::exists(ancien)) fs::remove(ancien);
    std::printf("\n=== TRANSFERT TERRE-LUNE : RECHERCHE AUTOMATIQUE ===\n");
    std::printf("Conditions conservees : %.1f km, %.4f km/s, angle %.1f deg\n", a.alt_depart, a.vitesse_depart,
                a.angle);
    std::printf("Site : latitude %s, longitude EST %s, altitude reference %s km\n", fmt_g(a.lat).c_str(),
                fmt_g(a.lon).c_str(), fmt_g(a.alt_site).c_str());
    std::fflush(stdout);
    Trajectoire mission(a.lat, a.lon, a.alt_site, a.date, a.jours, 5000.0, a.angle, a.max_attente_h, a.vitesse_depart,
                        a.alt_depart, a.essais, a.fenetre_j);
    json r = mission.executer();
    auto [csv_f, json_f] = mission.exporter(a.sortie);
    if (r["statut"] != "TRANSITION_ATTEINTE") {
        std::printf("\n[TRANSITION NON TROUVEE] %s\n", r["statut"].get<std::string>().c_str());
        std::printf("Instant du passage au plus pres : %s\n", r["instant_utc_minimum"].get<std::string>().c_str());
        std::printf("Altitude minimale : %.1f km\n", r["altitude_minimale_km"].get<double>());
        std::printf("Seuil de freinage estime : %.1f km\n", r["seuil_a_cet_instant_km"].get<double>());
        std::printf("Ecart lateral au site : %.1f km\n", r["distance_laterale_site_km"].get<double>());
        std::printf("Rapport : %s\n", json_f.string().c_str());
        std::printf("CSV : %s\n", csv_f.string().c_str());
        std::printf("Le moteur d'alunissage NE sera pas lance.\n");
        return false;
    }
    std::printf("\n[TRANSITION VALIDE POUR ESSAI]\n");
    std::printf("Date UTC : %s\n", r["instant_utc"].get<std::string>().c_str());
    std::printf("Altitude : %.2f km\n", r["critere"]["altitude_sur_site_km"].get<double>());
    std::printf("Vitesse lunaire : %.1f m/s\n", r["critere"]["vitesse_lunaire_ms"].get<double>());
    std::printf("Ecart lateral site : %.1f km\n", r["distance_laterale_site_km"].get<double>());
    std::printf("Delta-v theorique des 8 t d'ergols (indicatif) : %.1f m/s\n",
                r["delta_v_theorique_reservoir_nominal_ms"].get<double>());
    if (CARBURANT_ILLIMITE) std::printf("Mode essai : ergols ILLIMITES, masse de reference constante.\n");
    std::printf("Etat initial du module Alunissage : %s\n", json_f.string().c_str());
    std::printf("CSV : %s\n", csv_f.string().c_str());
    std::printf("ATTENTION : le seuil est un critere simplifie, pas une garantie de pose.\n");
    return true;
}

void simulation_alunissage(const Args& a) {
    double h = a.duree_descente_h;
    if (!(0.0 < h && h <= 24.0)) throw ValueError("Duree de descente : entre 0 et 24 heures");
    std::printf("\n=== ALUNISSAGE : DESCENTE MOTORISEE ===\n");
    std::fflush(stdout);
    Alunissage module(a.sortie / "etat_debut_alunissage.json", 3600.0 * h);
    json b = module.executer();
    auto [csv_f, bilan_f] = module.exporter(a.sortie);
    std::printf("Statut : %s\n", b["statut"].get<std::string>().c_str());
    std::printf("Duree simulee : %.1f min (maximum autorise : %.1f min)\n", b["duree_s"].get<double>() / 60,
                b["duree_max_s"].get<double>() / 60);
    std::printf("Altitude finale sur sphere de reference : %.2f km\n", b["altitude_sur_site_finale_km"].get<double>());
    std::printf("Vitesse lunaire finale : %.2f m/s\n", b["vitesse_finale_lunaire_ms"].get<double>());
    std::printf("Vitesse verticale finale : %.2f m/s (negative = descendante)\n",
                b["vitesse_verticale_finale_ms"].get<double>());
    std::printf("Vitesse horizontale finale : %.2f m/s\n", b["vitesse_horizontale_finale_ms"].get<double>());
    std::printf("Ecart au site : %.1f m\n", b["distance_site_finale_m"].get<double>());
    std::printf("Ecart a la verticale du site : %.2f km\n", b["ecart_surface_site_final_km"].get<double>());
    if (b["carburant_illimite"].get<bool>()) {
        std::printf("Mode : carburant illimite / masse constante (NON physique)\n");
        std::printf("Masse de reference : %.0f kg (reservoir nominal : %.0f kg)\n", b["masse_finale_kg"].get<double>(),
                    b["carburant_reservoir_reference_kg"].get<double>());
        std::printf("Carburant consomme (equivalent) : %.1f kg\n", b["carburant_consomme_kg"].get<double>());
        std::printf("Capacite nominale depassee de : %.1f kg\n", b["depassement_reservoir_kg"].get<double>());
    } else {
        std::printf("Carburant restant : %.1f kg\n", b["carburant_restant_kg"].get<double>());
    }
    std::printf("Delta-v du moteur : %.1f m/s\n", b["delta_v_moteur_ms"].get<double>());
    std::printf("CSV : %s\n", csv_f.string().c_str());
    std::printf("Bilan : %s\n", bilan_f.string().c_str());
    std::string st = b["statut"].get<std::string>();
    if (st != "CONTACT_CONTROLE_MODELE_SPHERIQUE") {
        if (st == "AUCUN_CONTACT_DANS_LA_DUREE")
            std::printf("[ARRET AU TEMPS MAX] Aucun contact detecte. Il faut examiner altitude et vitesse finale "
                        "avant toute conclusion.\n");
        else
            std::printf("[ECHEC MODELE] Contact avec vitesse ou erreur de position trop importante pour valider la "
                        "pose.\n");
    } else {
        std::printf("[CONTACT MODELE] A confirmer avec relief et guidage valide.\n");
    }
}

double parse_double(const std::string& name, const std::string& v) {
    try {
        std::size_t pos = 0;
        double d = std::stod(v, &pos);
        if (pos != v.size()) throw std::invalid_argument(v);
        return d;
    } catch (const std::exception&) {
        throw ValueError("argument " + name + ": invalid float value: '" + v + "'");
    }
}

int parse_int(const std::string& name, const std::string& v) {
    try {
        std::size_t pos = 0;
        int d = std::stoi(v, &pos);
        if (pos != v.size()) throw std::invalid_argument(v);
        return d;
    } catch (const std::exception&) {
        throw ValueError("argument " + name + ": invalid int value: '" + v + "'");
    }
}

Args parse_args(int argc, char** argv) {
    Args a;
    bool phase_set = false;
    for (int i = 1; i < argc; ++i) {
        std::string s = argv[i];
        if (s.rfind("--", 0) == 0) {
            std::string name = s, val;
            std::size_t eq = s.find('=');
            bool has_val = eq != std::string::npos;
            if (has_val) {
                name = s.substr(0, eq);
                val = s.substr(eq + 1);
            }
            auto next = [&]() {
                if (has_val) return val;
                if (i + 1 >= argc) throw ValueError("argument " + name + ": expected one argument");
                return std::string(argv[++i]);
            };
            if (name == "--lat") a.lat = parse_double(name, next());
            else if (name == "--lon") a.lon = parse_double(name, next());
            else if (name == "--alt-site") a.alt_site = parse_double(name, next());
            else if (name == "--date") a.date = next();
            else if (name == "--vitesse-depart") a.vitesse_depart = parse_double(name, next());
            else if (name == "--alt-depart") a.alt_depart = parse_double(name, next());
            else if (name == "--angle") a.angle = parse_double(name, next());
            else if (name == "--jours") a.jours = parse_double(name, next());
            else if (name == "--fenetre-j") a.fenetre_j = parse_double(name, next());
            else if (name == "--essais") a.essais = parse_int(name, next());
            else if (name == "--max-attente-h") a.max_attente_h = parse_double(name, next());
            else if (name == "--duree-descente-h") a.duree_descente_h = parse_double(name, next());
            else if (name == "--sortie") a.sortie = next();
            else throw ValueError("unrecognized arguments: " + s);
        } else {
            if (phase_set) throw ValueError("unrecognized arguments: " + s);
            if (s != "trajectoire" && s != "alunissage" && s != "complet")
                throw ValueError("argument phase: invalid choice: '" + s +
                                 "' (choose from trajectoire, alunissage, complet)");
            a.phase = s;
            phase_set = true;
        }
    }
    return a;
}

fs::path kernel_dir() {
    const char* env = std::getenv("SELENE_KERNEL_DIR");
    if (env && *env) return env;
    return SELENE_DEFAULT_KERNEL_DIR;
}

int run(int argc, char** argv) {
    Args a;
    try {
        a = parse_args(argc, argv);
    } catch (const ValueError& e) {
        std::fprintf(stderr, "vecteur-traj: error: %s\n", e.what());
        return 2;
    }
    selene::spice::load_kernels(kernel_dir());
    if (a.phase == "trajectoire" || a.phase == "complet") {
        bool valide = simulation_trajectoire(a);
        if (!valide) {
            if (a.phase == "complet") std::printf("[ALUNISSAGE NON LANCE] Aucun passage admissible trouve.\n");
            return 2;
        }
    }
    if (a.phase == "alunissage" || a.phase == "complet") simulation_alunissage(a);
    return 0;
}

}

int main(int argc, char** argv) {
    try {
        return selene::vt::run(argc, argv);
    } catch (const std::exception& e) {
        std::fflush(stdout);
        std::fprintf(stderr, "Erreur : %s\n", e.what());
        return 1;
    }
}
