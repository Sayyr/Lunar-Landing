import { describe, expect, it } from "vitest";

import { type PolarManifest, polarPixel } from "./polarDem";
import { polarInverse } from "./slopeOverlay";

// Same projection block as polar_s / polar_s_slope (LDEM_85S_20M).
const m = {
  projection: { center_lat: -90, center_lon: 0, radius_m: 1737400, line_off: 7583.5, sample_off: 7583.5, scale_m: 20, sign_y: 1, sign_line: -1 },
  levels: [{ level: 0, scale_m: 20, lines: 15168, samples: 15168, rows: 60, cols: 60 }],
  tile: 256,
} as unknown as PolarManifest;

describe("polarInverse", () => {
  it("inverts polarPixel (round trip) across the cap and the longitude wrap", () => {
    for (const [lat, lon] of [[-89.5, 0], [-86, 60], [-85.2, -120], [-87.3, 179.9], [-88, -179.9], [-89.99, 45]]) {
      const p = polarPixel(m, lat, lon);
      const q = polarInverse(m, p.line, p.sample);
      expect(q.lat).toBeCloseTo(lat, 9);
      expect(Math.abs(((q.lon - lon + 540) % 360) - 180)).toBeLessThan(1e-7);
    }
  });

  it("returns the pole with the centre longitude at the projection origin (deterministic)", () => {
    const q = polarInverse(m, 7583.5, 7583.5);
    expect(q.lat).toBe(-90);
    expect(q.lon).toBe(0);
  });

  it("puts the inscribed circle near 85°S for the 85S product", () => {
    expect(polarInverse(m, 7583.5, 15167.5).lat).toBeCloseTo(-85, 1);
  });
});

describe("localFrame", () => {
  const R = 1737.4;
  const DEG = Math.PI / 180;
  /** great-circle distance (km) on the reference sphere */
  const dist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
    const s =
      Math.sin(a.lat * DEG) * Math.sin(b.lat * DEG) + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.cos((a.lon - b.lon) * DEG);
    return R * Math.acos(Math.min(1, Math.max(-1, s)));
  };

  it("puts points at the requested distance, north = increasing latitude, east = increasing longitude", async () => {
    const { localFrame } = await import("./slopeOverlay");
    const f = localFrame(-30, 40);
    const n = f.at(0, 50);
    const e = f.at(50, 0);
    expect(dist({ lat: -30, lon: 40 }, n)).toBeCloseTo(50, 6);
    expect(dist({ lat: -30, lon: 40 }, f.at(30, -40))).toBeCloseTo(50, 6);
    expect(n.lat).toBeGreaterThan(-30);
    expect(n.lon).toBeCloseTo(40, 6);
    expect(e.lon).toBeGreaterThan(40);
  });

  it("is deterministic at the exact pole and across the date line", async () => {
    const { localFrame } = await import("./slopeOverlay");
    const p = localFrame(-90, 0).at(0, 100);
    expect(p.lat).toBeCloseTo(-90 + (100 / R) / DEG, 6); // north of the south pole = away from it
    const w = localFrame(10, 179.9).at(50, 0);
    expect(w.lon).toBeCloseTo(179.9 + (50 / (R * Math.cos(10 * DEG))) / DEG - 360, 2); // wrapped to [-180, 180)
    expect(dist({ lat: 10, lon: 179.9 }, w)).toBeCloseTo(50, 6);
  });
});

describe("SlopeScope mesh", () => {
  it("faces outward (front faces visible from space; regression: inverted winding drew nothing)", async () => {
    const THREE = await import("three");
    const { SlopeScope } = await import("./slopeOverlay");
    const { Heightmap } = await import("./heightmap");
    const hm = new Heightmap(new Float32Array(360 * 180), 360, 180, "flat");
    const s = new SlopeScope(null, null); // no polar product → coarse source
    for (const [lat, lon] of [[-67.7, 103.4], [10, -170], [45, 179.9]]) {
      await s.update(lat, lon, 50, hm);
      const pos = s.object.geometry.getAttribute("position");
      const idx = s.object.geometry.index!;
      const v = (k: number) => new THREE.Vector3().fromBufferAttribute(pos, idx.getX(k));
      for (const t of [0, Math.floor(idx.count / 6) * 3]) {
        const [a, b, c] = [v(t), v(t + 1), v(t + 2)];
        const normal = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
        expect(normal.dot(a)).toBeGreaterThan(0); // counter-clockwise seen from outside
      }
    }
    s.dispose();
  });

  it("cancel() hides the disc and stops a pending update from showing it again (review fix)", async () => {
    const { SlopeScope } = await import("./slopeOverlay");
    const { Heightmap } = await import("./heightmap");
    const { PolarDem } = await import("./polarDem");
    // Polar product whose tile download stays pending until we release it.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    globalThis.fetch = (async () => {
      await gate;
      return { status: 404, ok: false } as Response; // tile absent → no data, still resolves
    }) as never;
    const dem = new PolarDem(m, "/x/");
    const product = { dem, manifest: { ...m, status: "test", method: { baseline_m: 20 }, source: {} }, productId: "TEST" } as never;
    const s = new SlopeScope(product, null);
    const pending = s.update(-89.5, 0, 1, new Heightmap(new Float32Array(360 * 180), 360, 180, "flat"));
    s.cancel(); // filter switched off while tiles load
    release();
    expect(await pending).toBeNull();
    expect(s.object.visible).toBe(false);
    s.dispose();
  });
});
