import { describe, expect, it } from "vitest";

import { createWangContext, generateWangBank, tileFields, WANG_LAYERS, wangLayer } from "./wangBank";

type Colors = [number, number, number, number]; // n, e, s, w
const all: Colors[] = Array.from({ length: 16 }, (_, l) => [l & 1, (l >> 1) & 1, (l >> 2) & 1, (l >> 3) & 1]);
const SIZE = 64;
const ctx = createWangContext(SIZE, 3);
const S = SIZE + 2;
const fields = new Map(all.map((c) => [wangLayer(...c), tileFields(ctx, c)]));
const range = (a: Float32Array) => Math.max(...a) - Math.min(...a);

describe("Wang tile layout", () => {
  it("16 distinct layers for the 16 edge-colour combinations", () => {
    expect(new Set(all.map((c) => wangLayer(...c))).size).toBe(WANG_LAYERS);
  });
});

describe("tiles connect seamlessly whenever their shared edge colours match", () => {
  // The apron pixel of tile A just past its east edge is the same point as tile B's first column.
  const seam = (field: "height" | "albedo") => {
    let worst = 0;
    for (const a of all)
      for (const b of all) {
        if (a[1] !== b[3]) continue; // A.east must equal B.west
        const fa = fields.get(wangLayer(...a))![field];
        const fb = fields.get(wangLayer(...b))![field];
        for (let j = 1; j <= SIZE; j++) worst = Math.max(worst, Math.abs(fa[j * S + SIZE + 1] - fb[j * S + 1]));
      }
    return worst;
  };

  it("east–west seams: height and albedo continue across", () => {
    const h = fields.get(0)!.height;
    expect(seam("height")).toBeLessThan(0.01 * range(h));
    expect(seam("albedo")).toBeLessThan(0.01 * range(fields.get(0)!.albedo));
  });

  it("north–south seams: height continues across", () => {
    let worst = 0;
    for (const a of all)
      for (const b of all) {
        if (a[0] !== b[2]) continue; // A.north must equal B.south (B above A)
        const fa = fields.get(wangLayer(...a))!.height;
        const fb = fields.get(wangLayer(...b))!.height;
        for (let i = 1; i <= SIZE; i++) worst = Math.max(worst, Math.abs(fa[(SIZE + 1) * S + i] - fb[1 * S + i]));
      }
    expect(worst).toBeLessThan(0.01 * range(fields.get(0)!.height));
  });

  it("…while mismatched edges really differ (the test can fail)", () => {
    let worst = 0;
    for (const a of all)
      for (const b of all) {
        if (a[1] === b[3]) continue;
        const fa = fields.get(wangLayer(...a))!.height;
        const fb = fields.get(wangLayer(...b))!.height;
        for (let j = 1; j <= SIZE; j++) worst = Math.max(worst, Math.abs(fa[j * S + SIZE + 1] - fb[j * S + 1]));
      }
    expect(worst).toBeGreaterThan(0.02 * range(fields.get(0)!.height));
  });

  it("tiles differ inside (no two layers are copies)", () => {
    const centre = (l: number) => fields.get(l)!.height[(S >> 1) * S + (S >> 1)];
    expect(new Set(all.map((c) => centre(wangLayer(...c)).toFixed(5))).size).toBeGreaterThan(8);
  });
});

describe("generateWangBank", () => {
  it("fills every layer with valid normals and matte roughness", () => {
    const bank = generateWangBank(32, 5);
    expect(bank.albedoRough.length).toBe(16 * 32 * 32 * 4);
    for (let o = 0; o < bank.normal.length; o += 4) {
      const v = [bank.normal[o] / 127.5 - 1, bank.normal[o + 1] / 127.5 - 1, bank.normal[o + 2] / 127.5 - 1];
      expect(Math.abs(Math.hypot(...v) - 1)).toBeLessThan(0.02);
      expect(bank.albedoRough[o + 3]).toBeGreaterThanOrEqual(Math.round(0.85 * 255));
    }
    expect(bank.meanLinear).toBeGreaterThan(0.1);
    expect(bank.meanLinear).toBeLessThan(0.9);
  });
});
