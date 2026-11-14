#include "lunar_ephemeris.hpp"

#include <cmath>

namespace selene {

namespace {

// Meeus table 47.A (largest terms). Arguments are multiples of D, M, M', F; `l` is the sine
// coefficient of the longitude in 1e-6 deg, `r` the cosine coefficient of the distance in 1e-3 km.
struct TermLR {
    int d, m, mp, f;
    double l, r;
};
const TermLR TABLE_LR[] = {
    {0, 0, 1, 0, 6288774, -20905355}, {2, 0, -1, 0, 1274027, -3699111}, {2, 0, 0, 0, 658314, -2955968},
    {0, 0, 2, 0, 213618, -569925},    {0, 1, 0, 0, -185116, 48888},     {0, 0, 0, 2, -114332, -3149},
    {2, 0, -2, 0, 58793, 246158},     {2, -1, -1, 0, 57066, -152138},   {2, 0, 1, 0, 53322, -170733},
    {2, -1, 0, 0, 45758, -204586},    {0, 1, -1, 0, -40923, -129620},   {1, 0, 0, 0, -34720, 108743},
    {0, 1, 1, 0, -30383, 104755},     {2, 0, 0, -2, 15327, 10321},      {0, 0, 1, 2, -12528, 0},
    {0, 0, 1, -2, 10980, 79661},      {4, 0, -1, 0, 10675, -34782},     {0, 0, 3, 0, 10034, -23210},
    {4, 0, -2, 0, 8548, -21636},      {2, 1, -1, 0, -7888, 24208},      {2, 1, 0, 0, -6766, 30824},
    {1, 0, -1, 0, -5163, -8379},      {1, 1, 0, 0, 4987, -16675},       {2, -1, 1, 0, 4036, -12831},
    {2, 0, 2, 0, 3994, -10445},       {4, 0, 0, 0, 3861, -11650},       {2, 0, -3, 0, 3665, 14403},
};

// Meeus table 47.B (largest terms): sine coefficient of the latitude in 1e-6 deg.
struct TermB {
    int d, m, mp, f;
    double b;
};
const TermB TABLE_B[] = {
    {0, 0, 0, 1, 5128122}, {0, 0, 1, 1, 280602},  {0, 0, 1, -1, 277693},  {2, 0, 0, -1, 173237},
    {2, 0, -1, 1, 55413},  {2, 0, -1, -1, 46271}, {2, 0, 0, 1, 32573},    {0, 0, 2, 1, 17198},
    {2, 0, 1, -1, 9266},   {0, 0, 2, -1, 8822},   {2, -1, 0, -1, 8216},   {2, 0, -2, -1, 4324},
    {2, 0, 1, 1, 4200},    {2, 1, 0, -1, -3359},  {2, -1, -1, 1, 2463},   {2, -1, 0, 1, 2211},
    {2, -1, -1, -1, 2065}, {0, 1, -1, -1, -1870}, {4, 0, -1, -1, 1828},   {0, 1, 0, 1, -1794},
    {0, 0, 0, 3, -1749},   {0, 1, -1, 1, -1565},  {1, 0, 0, 1, -1491},    {0, 1, 1, 1, -1475},
    {0, 1, 1, -1, -1410},  {0, 1, 0, -1, -1344},  {1, 0, 0, -1, -1335},   {0, 0, 3, 1, 1107},
    {4, 0, 0, -1, 1021},   {4, 0, -1, 1, 833},
};

const double MOON_EQUATOR_INCLINATION_RAD = 1.54242 * PI / 180.0;  // I, to the ecliptic (IAU)

double rad(double deg) { return std::fmod(deg, 360.0) * PI / 180.0; }

// Terms containing the Sun's anomaly M are scaled by E^|m| (eccentricity of the Earth's orbit).
double ecc_factor(int m, double e) { return m == 0 ? 1.0 : (m == 1 || m == -1) ? e : e * e; }

Vec3 unit_from_lat_lon(double lat, double lon) {
    return {std::cos(lat) * std::cos(lon), std::cos(lat) * std::sin(lon), std::sin(lat)};
}

double dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

}  // namespace

double julian_date_utc(int64_t utc_us) { return static_cast<double>(utc_us) / 86400e6 + 2440587.5; }

MoonGeometry moon_geometry(double jde) {
    const double t = (jde - 2451545.0) / 36525.0;  // Julian centuries of TT from J2000.0
    const double t2 = t * t, t3 = t2 * t, t4 = t3 * t;

    // Mean elements, degrees (Meeus 47.1-47.5, 47.7).
    const double lp = 218.3164477 + 481267.88123421 * t - 0.0015786 * t2 + t3 / 538841.0 - t4 / 65194000.0;
    const double d = rad(297.8501921 + 445267.1114034 * t - 0.0018819 * t2 + t3 / 545868.0 - t4 / 113065000.0);
    const double m = rad(357.5291092 + 35999.0502909 * t - 0.0001536 * t2 + t3 / 24490000.0);
    const double mp = rad(134.9633964 + 477198.8675055 * t + 0.0087414 * t2 + t3 / 69699.0 - t4 / 14712000.0);
    const double f = rad(93.2720950 + 483202.0175233 * t - 0.0036539 * t2 - t3 / 3526000.0 + t4 / 863310000.0);
    const double omega = rad(125.0445479 - 1934.1362891 * t + 0.0020754 * t2 + t3 / 467441.0 - t4 / 60616000.0);
    const double a1 = rad(119.75 + 131.849 * t);
    const double a2 = rad(53.09 + 479264.290 * t);
    const double a3 = rad(313.45 + 481266.484 * t);
    const double e = 1.0 - 0.002516 * t - 0.0000074 * t2;
    const double lp_rad = rad(lp);

    double sum_l = 0.0, sum_r = 0.0, sum_b = 0.0;
    for (const TermLR& k : TABLE_LR) {
        const double arg = k.d * d + k.m * m + k.mp * mp + k.f * f, w = ecc_factor(k.m, e);
        sum_l += w * k.l * std::sin(arg);
        sum_r += w * k.r * std::cos(arg);
    }
    for (const TermB& k : TABLE_B)
        sum_b += ecc_factor(k.m, e) * k.b * std::sin(k.d * d + k.m * m + k.mp * mp + k.f * f);
    // Additive terms (Venus, Jupiter, flattening of the Earth).
    sum_l += 3958.0 * std::sin(a1) + 1962.0 * std::sin(lp_rad - f) + 318.0 * std::sin(a2);
    sum_b += -2235.0 * std::sin(lp_rad) + 382.0 * std::sin(a3) + 175.0 * std::sin(a1 - f) +
             175.0 * std::sin(a1 + f) + 127.0 * std::sin(lp_rad - mp) - 115.0 * std::sin(lp_rad + mp);

    MoonGeometry g{};
    g.longitude_rad = rad(lp + sum_l / 1e6);
    if (g.longitude_rad < 0.0) g.longitude_rad += 2.0 * PI;  // [0, 2 pi)
    g.latitude_rad = (sum_b / 1e6) * PI / 180.0;
    g.distance_km = 385000.56 + sum_r / 1000.0;

    // Optical librations (Meeus 53.1), nutation neglected: W = lambda - Omega.
    const double w = g.longitude_rad - omega, i = MOON_EQUATOR_INCLINATION_RAD;
    const double cb = std::cos(g.latitude_rad), sb = std::sin(g.latitude_rad);
    const double a = std::atan2(std::sin(w) * cb * std::cos(i) - sb * std::sin(i), std::cos(w) * cb);
    g.sub_earth_longitude_rad = std::remainder(a - f, 2.0 * PI);  // (-pi, pi]
    g.sub_earth_latitude_rad = std::asin(-std::sin(w) * cb * std::sin(i) - sb * std::cos(i));
    return g;
}

Vec3 earth_from_lunar_site_enu_km(const MoonGeometry& m, double lat, double lon, double height_km) {
    const Vec3 earth = unit_from_lat_lon(m.sub_earth_latitude_rad, m.sub_earth_longitude_rad);
    const Vec3 up = unit_from_lat_lon(lat, lon);
    const double r = MOON_RADIUS_KM + height_km;
    const Vec3 rel = {m.distance_km * earth[0] - r * up[0], m.distance_km * earth[1] - r * up[1],
                      m.distance_km * earth[2] - r * up[2]};
    const Vec3 east = {-std::sin(lon), std::cos(lon), 0.0};
    const Vec3 north = {-std::sin(lat) * std::cos(lon), -std::sin(lat) * std::sin(lon), std::cos(lat)};
    return {dot(rel, east), dot(rel, north), dot(rel, up)};
}

double site_offset_toward_earth_km(const MoonGeometry& m, double lat, double lon, double height_km) {
    return (MOON_RADIUS_KM + height_km) *
           dot(unit_from_lat_lon(lat, lon),
               unit_from_lat_lon(m.sub_earth_latitude_rad, m.sub_earth_longitude_rad));
}

Vec3 moon_earth_fixed_km(const MoonGeometry& m, double jd_utc) {
    const double t = (jd_utc - 2451545.0) / 36525.0;
    const double eps = rad(23.4392911 - 0.0130042 * t);  // mean obliquity (Meeus 22.2, leading terms)
    // Greenwich mean sidereal time (Meeus 12.4), UT1 ~= UTC.
    const double gmst = rad(280.46061837 + 360.98564736629 * (jd_utc - 2451545.0) + 0.000387933 * t * t -
                            t * t * t / 38710000.0);
    const double cb = std::cos(m.latitude_rad), sb = std::sin(m.latitude_rad);
    const double cl = std::cos(m.longitude_rad), sl = std::sin(m.longitude_rad);
    // Ecliptic -> equatorial of date.
    const double x = cb * cl;
    const double y = std::cos(eps) * cb * sl - std::sin(eps) * sb;
    const double z = std::sin(eps) * cb * sl + std::cos(eps) * sb;
    // Equatorial of date -> Earth-fixed: rotate by -GMST about Z.
    return {m.distance_km * (x * std::cos(gmst) + y * std::sin(gmst)),
            m.distance_km * (-x * std::sin(gmst) + y * std::cos(gmst)), m.distance_km * z};
}

StationView moon_from_earth_station(const Vec3& moon, double lat, double lon, double altitude_km) {
    const double e2 = EARTH_FLATTENING * (2.0 - EARTH_FLATTENING);
    const double n = EARTH_EQUATORIAL_RADIUS_KM / std::sqrt(1.0 - e2 * std::sin(lat) * std::sin(lat));
    const Vec3 up = unit_from_lat_lon(lat, lon);  // geodetic normal
    const Vec3 station = {(n + altitude_km) * up[0], (n + altitude_km) * up[1],
                          (n * (1.0 - e2) + altitude_km) * up[2]};
    const Vec3 rel = {moon[0] - station[0], moon[1] - station[1], moon[2] - station[2]};
    const double range = std::sqrt(dot(rel, rel));
    return {std::asin(dot(rel, up) / range), range};
}

}  // namespace selene
