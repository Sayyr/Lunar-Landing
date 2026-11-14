// Analytic LOW-PRECISION Earth-Moon geometry (no SPICE, no kernels).
//
// Source of every formula and coefficient: J. Meeus, "Astronomical Algorithms", 2nd ed.
// (1998): chapter 47 (position of the Moon, ELP-2000/82 truncated series), chapter 53
// (optical librations), chapter 22 (mean obliquity), chapter 12 (sidereal time).
// The periodic series here are TRUNCATED to the largest terms.
//
// Accuracy (tested in tests/tests.cpp against Meeus' worked examples 47.a and 53.a, i.e. ONE
// epoch; NOT yet cross-checked against SPICE/JPL Horizons, see docs/validation.md):
//   Moon geocentric longitude/latitude  ~0.01 deg, distance ~50 km (measured at that epoch:
//   0.0007 deg, 0.0006 deg, 35 km)
//   sub-Earth point (optical libration) ~0.02 deg; physical librations (<= 0.04 deg),
//   nutation (<= 0.005 deg), light time and aberration are NOT modelled.
// Budget for the Earth's direction seen from a lunar site: ~0.1 deg. Near the lunar poles the
// Earth's elevation changes by ~0.5 deg/day, so a 0.1 deg error moves a rise/set time by hours.
//
// Frames and time:
// - Lunar body-fixed frame: mean Earth / polar axis (the frame SPICE calls MOON_ME), built from
//   the mean elements, optical librations only. X = mean sub-Earth meridian, Z = north pole.
// - Earth: equator and mean equinox of date; Earth-fixed via Greenwich MEAN sidereal time with
//   UT1 ~= UTC (|UT1-UTC| < 0.9 s, i.e. < 0.004 deg of rotation). WGS84 ellipsoid for stations.
// - UTC -> TT by the fixed offset TT - UTC = 69.184 s (37 leap seconds + 32.184 s), exact from
//   2017-01-01 until the next leap second; no leap-second table is consulted.
// - Internal units: radians, kilometres, days. Callers convert at the JSON boundary.
#pragma once

#include <cstdint>

#include "geometry.hpp"

namespace selene {

constexpr double MOON_RADIUS_KM = 1737.4;        // spherical reference radius (as the team's SPICE scripts)
constexpr double EARTH_EQUATORIAL_RADIUS_KM = 6378.137;  // WGS84 a
constexpr double EARTH_FLATTENING = 1.0 / 298.257223563;  // WGS84 f
constexpr double TT_MINUS_UTC_S = 69.184;

// UTC microseconds since 1970-01-01T00:00:00Z -> Julian date on the UTC scale.
double julian_date_utc(int64_t utc_us);

struct MoonGeometry {
    double longitude_rad;  // geocentric ecliptic longitude, mean equinox of date
    double latitude_rad;   // geocentric ecliptic latitude
    double distance_km;    // Earth centre to Moon centre
    double sub_earth_longitude_rad;  // selenographic east longitude of the sub-Earth point (libration l')
    double sub_earth_latitude_rad;   // selenographic latitude of the sub-Earth point (libration b')
};

// `jde`: Julian Ephemeris Day (TT).
MoonGeometry moon_geometry(double jde);

// Earth centre relative to a lunar surface observer, km, in the observer's local East-North-Up
// frame. `lat_rad` planetocentric, `lon_rad` east-positive, observer at MOON_RADIUS_KM + height.
// At the exact poles east/north are taken from the request longitude (deterministic convention:
// "north" is the horizontal direction of the meridian plane of `lon_rad`).
Vec3 earth_from_lunar_site_enu_km(const MoonGeometry& m, double lat_rad, double lon_rad, double height_km);

// Component of the observer's selenocentric position along the Moon->Earth line, km (> 0 when the
// observer is on the Earth-facing side). Used to refer an Earth-station range to the site instead
// of the Moon's centre; the neglected transverse term is <= R_moon^2 / (2 d) ~ 4 km.
double site_offset_toward_earth_km(const MoonGeometry& m, double lat_rad, double lon_rad, double height_km);

// Moon centre in the Earth-fixed frame (X through Greenwich meridian/equator, Z north), km.
// `jd_utc` drives the Earth's rotation, `m` must be moon_geometry(jd_utc + TT_MINUS_UTC_S/86400).
Vec3 moon_earth_fixed_km(const MoonGeometry& m, double jd_utc);

struct StationView {
    double elevation_rad;  // Moon centre above the station's geodetic horizon (no refraction)
    double range_km;       // station to Moon centre
};

// `lat_rad` geodetic (WGS84), `lon_rad` east-positive, `altitude_km` above the ellipsoid.
StationView moon_from_earth_station(const Vec3& moon_earth_fixed, double lat_rad, double lon_rad,
                                    double altitude_km);

}  // namespace selene
