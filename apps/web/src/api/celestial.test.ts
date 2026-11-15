import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { moonSky } from "../lunar/skyGeometry";
import { eclipticOfDateToJ2000, getCelestialState, getMoonTrack, resetCelestialClient } from "./celestial";
import type { CelestialStateResponse } from "./celestialTypes";

// Real SPICE output (generated fixture, 2026-11-15T00:00:00Z).
const FIXTURE: CelestialStateResponse = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../packages/contracts/fixtures/celestial-state-response.computed.json", import.meta.url)), "utf8"),
);
const DATE = new Date("2026-11-15T00:00:00Z");

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("getCelestialState", () => {
  beforeEach(() => resetCelestialClient());
  afterEach(() => vi.unstubAllGlobals());

  it("returns the backend's SPICE state and asks for the exact UTC instant", async () => {
    const fetchMock = vi.fn(async () => reply(200, FIXTURE));
    vi.stubGlobal("fetch", fetchMock);
    const state = await getCelestialState(DATE);
    expect(state.synthetic).toBe(false);
    expect(state.model.provider).toBe("spice");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/celestial\/state$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ utc: "2026-11-15T00:00:00.000Z" });
  });

  it("caches an instant already fetched", async () => {
    const fetchMock = vi.fn(async () => reply(200, FIXTURE));
    vi.stubGlobal("fetch", fetchMock);
    await getCelestialState(DATE);
    await getCelestialState(new Date(DATE.getTime()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the labelled mock when ephemerides are unavailable, then backs off", async () => {
    const fetchMock = vi.fn(async () =>
      reply(503, { error: { code: "science_unavailable", message: "Ephemerides not available: SELENE_KERNEL_DIR not set", details: [] } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = await getCelestialState(DATE);
    expect(state.synthetic).toBe(true);
    expect(state.status).toBe("synthetic");
    expect(state.model.provider).toBe("mock_low_precision");
    expect(state.warnings[0]).toContain("SELENE_KERNEL_DIR not set");
    expect(state.warnings.some((w) => w.includes("SYNTHETIC"))).toBe(true);
    // The views tick many times per second: no new request during the back-off.
    await getCelestialState(new Date(DATE.getTime() + 1000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const state = await getCelestialState(DATE);
    expect(state.synthetic).toBe(true);
    expect(state.warnings[0]).toContain("fetch failed");
  });

  it("rejects an invalid date without calling the backend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCelestialState(new Date(NaN))).rejects.toThrow("invalid date");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("real state through the existing sky geometry", () => {
  it("gives unit Sun/Earth directions in the Moon body frame, Earth near +X (libration < 8.5°)", () => {
    const sky = moonSky(FIXTURE);
    for (const v of [sky.sun, sky.earth]) expect(Math.hypot(...v)).toBeCloseTo(1, 12);
    const fromX = (Math.acos(sky.earth[0]) * 180) / Math.PI;
    expect(fromX).toBeLessThan(8.5);
    // Sub-solar latitude stays within the 1.54° inclination of the lunar equator to the ecliptic.
    expect(Math.abs((Math.asin(sky.sun[2]) * 180) / Math.PI)).toBeLessThan(1.7);
  });
});

describe("orbit traces", () => {
  it("rotates ecliptic-of-date points to J2000 by the precession in longitude", () => {
    // 26.87 years after J2000: p = 1.3969°/century × 0.2687 ≈ 0.3754°; longitude decreases.
    const [[x, y, z]] = eclipticOfDateToJ2000([[1, 0, 0.5]], DATE);
    expect((Math.atan2(y, x) * 180) / Math.PI).toBeCloseTo(-0.3754, 3);
    expect(Math.hypot(x, y)).toBeCloseTo(1, 12);
    expect(z).toBe(0.5);
    // At J2000 itself: identity.
    expect(eclipticOfDateToJ2000([[1, 2, 3]], new Date(Date.UTC(2000, 0, 1, 12)))[0]).toEqual([1, 2, 3]);
  });

  it("the J2000 trace passes close to the real Moon position", () => {
    const moon = FIXTURE.moon_from_earth.position_m;
    const nearest = (track: [number, number, number][]) =>
      Math.min(...track.map((p) => Math.hypot(p[0] - moon[0], p[1] - moon[1], p[2] - moon[2])));
    const j2000 = nearest(getMoonTrack(DATE, true));
    // Low-precision trace sampled every ~3 h: within a few thousand km of the SPICE position.
    expect(j2000).toBeLessThan(6_000_000);
    expect(j2000).toBeLessThan(nearest(getMoonTrack(DATE, false)) + 1);
  });
});
