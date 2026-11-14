import { afterEach, describe, expect, it, vi } from "vitest";

import { type BandManifest, bandOrderNear, streamBands } from "./loaders";

const W = 8;
const H = 4;
const manifest: BandManifest = {
  source: "test",
  width: W,
  height: H,
  dtype: "float32le",
  bands: [
    { file: "band_00.f32", row0: 0, rows: 2, bytes: 2 * W * 4 },
    { file: "band_01.f32", row0: 2, rows: 2, bytes: 2 * W * 4 },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("bandOrderNear", () => {
  it("nearest band to the latitude first", () => {
    expect(bandOrderNear(manifest, -80)).toEqual([0, 1]);
    expect(bandOrderNear(manifest, 70)).toEqual([1, 0]);
  });
});

describe("streamBands", () => {
  it("writes each band at its rows, in order, and reports it", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const v = url.endsWith("band_00.f32") ? 1 : 2;
      return new Response(new Float32Array(2 * W).fill(v).buffer);
    });
    const target = new Float32Array(W * H);
    const seen: number[] = [];
    const n = await streamBands("/x/", manifest, target, [1, 0], (row0) => seen.push(row0), 1);
    expect(n).toBe(2);
    expect(seen).toEqual([2, 0]);
    expect(target[0]).toBe(1);
    expect(target[W * 3]).toBe(2);
  });

  it("skips a failed or wrong-sized band without touching its rows", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("band_00.f32") ? new Response(null, { status: 404 }) : new Response(new Float32Array(3).buffer),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = new Float32Array(W * H).fill(7);
    const n = await streamBands("/x/", manifest, target, [0, 1], () => {});
    expect(n).toBe(0);
    expect(target.every((v) => v === 7)).toBe(true);
  });
});
