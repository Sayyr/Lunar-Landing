import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { moonSky } from "../lunar/skyGeometry";
import { getCelestialState, getCelestialTracks, resetCelestialClient } from "./celestial";
import type { CelestialStateResponse, CelestialTracksResponse } from "./celestialTypes";

// Real SPICE output (generated fixtures, 2026-11-15T00:00:00Z).
const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../packages/contracts/fixtures/${name}`, import.meta.url)), "utf8"));
const FIXTURE: CelestialStateResponse = fixture("celestial-state-response.computed.json");
const TRACKS: CelestialTracksResponse = fixture("celestial-tracks-response.computed.json");
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

  it("rejects with the backend's reason when ephemerides are unavailable (no browser fallback), then backs off", async () => {
    const fetchMock = vi.fn(async () =>
      reply(503, { error: { code: "science_unavailable", message: "Ephemerides not available: SELENE_KERNEL_DIR not set", details: [] } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCelestialState(DATE)).rejects.toThrow("SELENE_KERNEL_DIR not set");
    // The views tick many times per second: no new request during the back-off, same reason.
    await expect(getCelestialState(new Date(DATE.getTime() + 1000))).rejects.toThrow("SELENE_KERNEL_DIR not set");
    await expect(getCelestialTracks(DATE)).rejects.toThrow("SELENE_KERNEL_DIR not set");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(getCelestialState(DATE)).rejects.toThrow("Backend not reachable (fetch failed)");
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

describe("getCelestialTracks", () => {
  beforeEach(() => resetCelestialClient());
  afterEach(() => vi.unstubAllGlobals());

  it("returns the backend's SPICE traces, asked for the exact instant, and caches them", async () => {
    const fetchMock = vi.fn(async () => reply(200, TRACKS));
    vi.stubGlobal("fetch", fetchMock);
    const t = await getCelestialTracks(DATE);
    await getCelestialTracks(new Date(DATE.getTime()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/celestial\/tracks$/);
    expect(JSON.parse(init.body as string)).toEqual({ utc: "2026-11-15T00:00:00.000Z" });
    expect(t.model.provider).toBe("spice");
  });

  it("the Moon trace passes through the state's Moon position (same instant, same frame)", () => {
    const moon = FIXTURE.moon_from_earth.position_m;
    const nearest = Math.min(...TRACKS.moon_from_earth.positions_m.map((p) => Math.hypot(p[0] - moon[0], p[1] - moon[1], p[2] - moon[2])));
    expect(nearest).toBeLessThan(1);
  });
});
