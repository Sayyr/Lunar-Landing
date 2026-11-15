"""Checks on a ScenarioResponse that need no astronomy.

They check labelling, the time grid documented in docs/validation.md and the consistency
between samples and windows. No ephemeris is recomputed here. Each check returns a list of
problems (empty = OK), so the same code runs on shared fixtures, mutated fixtures and live
responses.
"""

from __future__ import annotations

import math
import re
from datetime import UTC, datetime, timedelta

UTC_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$")
BODIES = ("sun", "earth")
WINDOW_KEY = {"sun": "sun_visible", "earth": "earth_visible"}
# Window edges are rounded to 1 ms by the science service (format_utc truncates).
EDGE_TOL = timedelta(milliseconds=1.5)


def parse_utc(value: str) -> datetime:
    """Parse the contract's 'Z' timestamps; fractions beyond microseconds are truncated."""
    m = UTC_RE.match(value)
    if not m:
        raise ValueError(f"not an ISO 8601 UTC 'Z' timestamp: {value!r}")
    base = datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=UTC)
    frac = (m.group(2) or "")[:6].ljust(6, "0")
    return base + timedelta(microseconds=int(frac))


def expected_sample_count(request: dict) -> int:
    """docs/validation.md: k = 0 … floor(duration·60/step), inclusive of the start."""
    return int((request["duration_hours"] * 60) // request["step_minutes"]) + 1


# --- labelling ---------------------------------------------------------------------------


def check_labelling(resp: dict) -> list[str]:
    p: list[str] = []
    status, synthetic, model = resp["status"], resp["synthetic"], resp["model"]
    provider = model["ephemeris_provider"]
    if status == "synthetic":
        if synthetic is not True:
            p.append("status 'synthetic' but synthetic flag is not true")
        if provider != "synthetic_fixture":
            p.append(f"status 'synthetic' but ephemeris_provider={provider!r}")
        if not any("SYNTHETIC" in w for w in resp["warnings"]):
            p.append("synthetic response has no 'SYNTHETIC' warning for the UI")
        if not any(d["kind"] == "synthetic" for d in resp["data_provenance"]):
            p.append("synthetic response has no provenance entry of kind 'synthetic'")
        if model["kernel_set"] or model["body_fixed_frame"] is not None:
            p.append("synthetic response claims SPICE kernels or a body-fixed frame")
    if status == "computed":
        if synthetic is not False:
            p.append("status 'computed' but synthetic flag is not false")
        if provider != "spice":
            p.append(f"status 'computed' but ephemeris_provider={provider!r}")
        if not model["body_fixed_frame"]:
            p.append("computed response does not name its body-fixed frame (CLAUDE.md)")
        if not model["kernel_set"]:
            p.append("computed response lists no loaded SPICE kernels")
        kernels = [d for d in resp["data_provenance"] if d["kind"] == "spice_kernel"]
        if not kernels:
            p.append("computed response has no spice_kernel provenance entries")
        if any(d["kind"] == "synthetic" for d in resp["data_provenance"]):
            p.append("computed response mixes in synthetic provenance")
        if "TDB" not in model["time_scale_note"] and "ET" not in model["time_scale_note"]:
            p.append("computed response time_scale_note does not state the UTC→ET/TDB conversion")
    if status == "not_ready":
        if synthetic is not False:
            p.append("not_ready response is flagged synthetic")
        if resp["samples"] or resp["windows"]["sun_visible"] or resp["windows"]["earth_visible"]:
            p.append("not_ready response carries samples or windows")
        if not resp["message"].strip():
            p.append("not_ready response has an empty message (no reason for the UI)")
    if status in ("computed", "synthetic") and not resp["samples"]:
        p.append(f"status {status!r} but no samples")
    terrain = resp["request"]["terrain_mode"]
    expected_horizon = {"ideal": "ideal_geometric", "dem": "dem_terrain"}[terrain]
    if model["horizon_model"] != expected_horizon:
        p.append(f"terrain_mode {terrain!r} answered with horizon_model {model['horizon_model']!r}")
    if resp["samples"]:
        text = " ".join(resp["assumptions"]).lower()
        if "power" not in text or "radio" not in text:
            p.append("assumptions do not say geometric visibility is not a power/radio guarantee")
    return p


def check_request_echo(resp: dict, sent: dict) -> list[str]:
    got = resp["request"]
    p = []
    for key in ("start_utc", "terrain_mode"):
        if got[key] != sent[key]:
            p.append(f"request.{key} echoed as {got[key]!r}, sent {sent[key]!r}")
    for key in ("duration_hours", "step_minutes"):
        if not math.isclose(got[key], sent[key], rel_tol=0, abs_tol=1e-12):
            p.append(f"request.{key} echoed as {got[key]!r}, sent {sent[key]!r}")
    for key, value in sent["site"].items():
        if not math.isclose(got["site"][key], value, rel_tol=0, abs_tol=1e-12):
            p.append(f"request.site.{key} echoed as {got['site'][key]!r}, sent {value!r}")
    return p


# --- time grid ----------------------------------------------------------------------------


def check_time_grid(resp: dict) -> list[str]:
    samples = resp["samples"]
    if not samples:
        return []
    req = resp["request"]
    p: list[str] = []
    try:
        times = [parse_utc(s["utc"]) for s in samples]
    except ValueError as e:
        return [str(e)]
    start = parse_utc(req["start_utc"])
    step = timedelta(minutes=req["step_minutes"])
    end = start + timedelta(hours=req["duration_hours"])
    n = expected_sample_count(req)
    if len(samples) != n:
        p.append(f"{len(samples)} samples, docs/validation.md rule gives {n}")
    # The response prints milliseconds; the grid itself may need microseconds.
    tol = timedelta(milliseconds=1)
    for k, t in enumerate(times):
        if abs(t - (start + k * step)) > tol:
            p.append(f"sample {k} at {samples[k]['utc']}, expected start + {k}·step")
            break
    if any(b <= a for a, b in zip(times, times[1:], strict=False)):
        p.append("sample times are not strictly increasing")
    if times[0] - start > tol or start - times[0] > tol:
        p.append("first sample is not the scenario start")
    if times[-1] - end > tol:
        p.append("last sample is after start + duration")
    return p


# --- directions ---------------------------------------------------------------------------


def check_directions(resp: dict) -> list[str]:
    p = []
    for k, s in enumerate(resp["samples"]):
        for body in BODIES:
            az, el = s[body]["azimuth_deg"], s[body]["elevation_deg"]
            if not (math.isfinite(az) and math.isfinite(el)):
                p.append(f"sample {k} {body}: non-finite az/el")
            elif not (0 <= az < 360 and -90 <= el <= 90):
                p.append(f"sample {k} {body}: az={az} el={el} out of range")
    return p[:10]


# --- windows vs samples -------------------------------------------------------------------


def _positive_runs(elev: list[float]) -> list[tuple[int, int]]:
    runs, start = [], None
    for i, e in enumerate(elev):
        if e > 0 and start is None:
            start = i
        elif e <= 0 and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, len(elev) - 1))
    return runs


def check_windows(resp: dict) -> list[str]:
    """Windows must be the above-horizon runs of the samples (strict).

    The horizon is 0 deg for the ideal model and `horizon_elevation_deg` (terrain horizon at the
    body's azimuth) when the response carries it.
    """
    samples = resp["samples"]
    if not samples:
        return []
    try:
        times = [parse_utc(s["utc"]) for s in samples]
    except ValueError as e:
        return [f"windows not checked: {e}"]
    p: list[str] = []
    for body in BODIES:
        key = WINDOW_KEY[body]
        windows = resp["windows"][key]
        elev = [s[body]["elevation_deg"] - s[body].get("horizon_elevation_deg", 0.0) for s in samples]
        runs = _positive_runs(elev)
        if len(windows) != len(runs):
            p.append(f"{key}: {len(windows)} windows but {len(runs)} above-horizon sample runs")
            continue
        prev_end = None
        for w, (i, j) in zip(windows, runs, strict=True):
            ws, we = parse_utc(w["start_utc"]), parse_utc(w["end_utc"])
            label = f"{key} [{w['start_utc']} → {w['end_utc']}]"
            if we < ws:
                p.append(f"{label}: ends before it starts")
            if prev_end is not None and ws < prev_end:
                p.append(f"{label}: overlaps or is out of order with the previous window")
            prev_end = we
            if ws < times[0] - EDGE_TOL or we > times[-1] + EDGE_TOL:
                p.append(f"{label}: outside the sampled range")
            # Start lies in the gap before the first positive sample of the run.
            lo = times[i - 1] if i > 0 else times[0]
            if not (lo - EDGE_TOL <= ws <= times[i] + EDGE_TOL):
                p.append(f"{label}: start not bracketed by samples {max(i - 1, 0)}..{i}")
            hi = times[j + 1] if j + 1 < len(times) else times[-1]
            if not (times[j] - EDGE_TOL <= we <= hi + EDGE_TOL):
                p.append(f"{label}: end not bracketed by samples {j}..{j + 1}")
            if w["clipped_start"] != (i == 0):
                p.append(
                    f"{label}: clipped_start={w['clipped_start']} but run starts at sample {i}"
                )
            if w["clipped_end"] != (j == len(times) - 1):
                p.append(f"{label}: clipped_end={w['clipped_end']} but run ends at sample {j}")
    return p


def check_all(resp: dict, sent: dict | None = None) -> list[str]:
    problems = check_labelling(resp) + check_time_grid(resp) + check_directions(resp)
    problems += check_windows(resp) + check_terrain(resp)
    if sent is not None:
        problems += check_request_echo(resp, sent)
    return problems


# --- physical plausibility (computed responses only) --------------------------------------
# Order-of-magnitude bounds from well-known lunar geometry, documented in fixtures/README.md.
# They catch gross errors (wrong frame, degrees/radians, swapped bodies). They are NOT a validation.

# Lunar sidereal rotation 360°/655.7 h ≈ 0.55°/h bounds how fast any distant body can move
# across the local sky. Margin added for topocentric effects.
MAX_ELEVATION_RATE_DEG_PER_H = 0.6
# Sun stays within ~1.54° of the lunar equator (inclination of the equator to the ecliptic).
SUN_DECLINATION_BOUND_DEG = 1.6
# Earth's declination in the lunar body frame (latitude libration ≈ ±6.7°) + parallax (≈0.26°).
EARTH_DECLINATION_BOUND_DEG = 7.5


def check_physical_plausibility(resp: dict) -> list[str]:
    if resp["status"] != "computed":
        return []
    req = resp["request"]
    lat = abs(req["site"]["latitude_deg"])
    p = []
    times = [parse_utc(s["utc"]) for s in resp["samples"]]
    for body, bound in (("sun", SUN_DECLINATION_BOUND_DEG), ("earth", EARTH_DECLINATION_BOUND_DEG)):
        elev = [s[body]["elevation_deg"] for s in resp["samples"]]
        limit = 90 - lat + bound
        worst = max(abs(e) for e in elev)
        if worst > limit:
            p.append(
                f"{body}: |elevation| reaches {worst:.3f}° at |lat|={lat}°, bound {limit:.2f}°"
            )
        for k in range(1, len(elev)):
            dt_h = (times[k] - times[k - 1]).total_seconds() / 3600
            if abs(elev[k] - elev[k - 1]) > MAX_ELEVATION_RATE_DEG_PER_H * dt_h + 0.01:
                p.append(
                    f"{body}: elevation jumps {elev[k] - elev[k - 1]:+.3f}° in {dt_h:.3f} h "
                    f"at sample {k} (bound {MAX_ELEVATION_RATE_DEG_PER_H}°/h)"
                )
                break
    return p


# --- DEM terrain horizon ------------------------------------------------------------------


def check_terrain(resp: dict) -> list[str]:
    """The terrain block and the per-sample horizon appear together, only for the DEM model."""
    p: list[str] = []
    dem = resp["model"]["horizon_model"] == "dem_terrain"
    terrain = resp.get("terrain_horizon")
    has_numbers = bool(resp["samples"])
    per_sample = [body for s in resp["samples"] for body in BODIES if "horizon_elevation_deg" in s[body]]
    if not dem:
        if terrain is not None or per_sample:
            p.append("ideal-horizon response carries terrain horizon data")
        return p
    if not has_numbers:
        if terrain is not None:
            p.append("terrain_horizon present without samples")
        return p
    if terrain is None:
        return ["dem_terrain result without a terrain_horizon block"]
    if len(per_sample) != len(resp["samples"]) * len(BODIES):
        p.append("dem_terrain result: some samples lack horizon_elevation_deg")
    n = len(terrain["elevation_deg"])
    if abs(n * terrain["azimuth_step_deg"] - 360.0) > 1e-9:
        p.append(f"terrain profile: {n} bearings x {terrain['azimuth_step_deg']} deg is not 360 deg")
    if not any(d["kind"] in ("dem", "synthetic") and "DEM" in d["notes"] for d in resp["data_provenance"]):
        p.append("dem_terrain result has no DEM provenance entry")
    # Each sample's horizon must be the profile interpolated at the body's azimuth.
    step, prof = terrain["azimuth_step_deg"], terrain["elevation_deg"]
    for k, s in enumerate(resp["samples"]):
        for body in BODIES:
            x = (s[body]["azimuth_deg"] % 360.0) / step
            i, f = int(x) % n, x - int(x)
            want = prof[i] * (1 - f) + prof[(i + 1) % n] * f
            if abs(want - s[body].get("horizon_elevation_deg", want)) > 1e-6:
                p.append(f"sample {k} {body}: horizon {s[body]['horizon_elevation_deg']} != profile {want:.6f}")
                return p
    return p
