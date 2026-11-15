import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { TrajectoryResponse } from "../api/trajectoryTypes";
import { arrivalUtc, computeMissionTrajectory, landingGapHours, missionDepartureUtc, positionAt, toTrajectoryView, trajectoryPoints } from "./trajectory";

// Read at test time (not imported): the web Docker build copies only apps/web.
const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../packages/contracts/fixtures/${name}`, import.meta.url)), "utf8"));
const r = fixture("trajectory-simulate-response.computed.json") as TrajectoryResponse;

describe("trajectory", () => {
  it("flattens the segments in time order without the shared boundary twice", () => {
    const pts = trajectoryPoints(r);
    const n = r.segments.reduce((k, s) => k + s.utc.length, 0);
    expect(pts.length).toBeGreaterThan(n - r.segments.length - 1);
    for (let i = 1; i < pts.length; i++) expect(pts[i].t).toBeGreaterThan(pts[i - 1].t);
    expect(pts[0].phase).toBe("transfer");
    expect(pts.at(-1)!.phase).toBe("descent");
  });

  it("interpolates between samples and is null outside the span", () => {
    const pts = trajectoryPoints(r);
    expect(positionAt(pts, pts[0].t - 1)).toBeNull();
    expect(positionAt(pts, pts.at(-1)!.t + 1)).toBeNull();
    expect(positionAt(pts, pts[5].t)!.p).toEqual(pts[5].p);
    const mid = positionAt(pts, (pts[5].t + pts[6].t) / 2)!;
    expect(mid.p[0]).toBeCloseTo((pts[5].p[0] + pts[6].p[0]) / 2, 3);
  });

  it("finds the arrival (start of descent)", () => {
    expect(arrivalUtc(r)).toBe(r.segments[1].utc[0]);
  });
});

describe("mission trajectory", () => {
  it("departs the transfer duration before the landing, to the minute", () => {
    expect(missionDepartureUtc("2027-01-06T07:00:00Z", 4.5)).toBe("2027-01-01T19:00:00Z");
    expect(missionDepartureUtc("2027-01-06T07:00:20Z", 1 / 1440)).toBe("2027-01-06T06:59:00Z");
  });

  it("measures the computed end against the planned landing", () => {
    const v = toTrajectoryView(r, { label: "m", landingUtc: "2027-01-06T07:00:00Z" });
    const end = v.points.at(-1)!.t;
    expect(landingGapHours(v, "2027-01-06T07:00:00Z")).toBeCloseTo((end - Date.parse("2027-01-06T07:00:00Z")) / 3_600_000, 9);
  });
});

describe("computeMissionTrajectory", () => {
  // Fake tool: the descent always ends 20 h after the departure + 4.5 d, i.e. 20 h late on the first run.
  const shift = (resp: TrajectoryResponse, ms: number): TrajectoryResponse => ({
    ...resp,
    segments: resp.segments.map((s) => ({ ...s, utc: s.utc.map((u) => new Date(Date.parse(u) + ms).toISOString()) })),
  });
  const end0 = Date.parse(r.segments.at(-1)!.utc.at(-1)!);
  const dep0 = Date.parse(r.segments[0].utc[0]);
  const fake = async (req: { departure_utc: string }) => shift(r, Date.parse(req.departure_utc) - dep0);

  it("shifts the departure until the end of descent meets the landing", async () => {
    const landing = new Date(end0 - 20 * 3_600_000).toISOString();
    const res = await computeMissionTrajectory(fake, { name: "good run", site: { latitude_deg: -85, longitude_deg: -30 }, landingUtc: landing, transferDays: 4.5 });
    expect(Math.abs(res.gapHours)).toBeLessThanOrEqual(1);
    expect(res.view.mission).toEqual({ label: "good run", landingUtc: landing });
  });

  it("reports the tool's message when nothing is computed", async () => {
    const none = async () => ({ ...r, status: "no_solution" as const, message: "nothing", segments: [] });
    await expect(computeMissionTrajectory(none, { name: "x", site: { latitude_deg: 0, longitude_deg: 0 }, landingUtc: "2027-01-06T00:00:00Z", transferDays: 4.5 })).rejects.toThrow("no_solution: nothing");
  });
});
