import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { TileLayer } from "./tileLayer";

/** TileLayer with downloads answered synchronously (no network in tests). */
function layer(fail = false) {
  const l = new TileLayer(null, 1, 4096);
  const urls: string[] = [];
  (l as unknown as { loader: { load: unknown } }).loader.load = (url: string, ok: (t: THREE.Texture) => void, _p: unknown, err: () => void) => {
    urls.push(url);
    if (fail) err();
    else ok(new THREE.Texture());
  };
  return { l, urls };
}

function camera(altitude: number, lat = 0) {
  const c = new THREE.PerspectiveCamera(40, 16 / 9, 0.001, 100);
  const r = 1 + altitude;
  c.position.set(r * Math.cos((lat * Math.PI) / 180), r * Math.sin((lat * Math.PI) / 180), 0);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld();
  return c;
}

const drawn = (l: TileLayer) => l.group.children.filter((m) => m.visible) as THREE.Mesh[];
const level = (url: string) => Number(url.match(/default028mm\/(\d+)\//)![1]);

function settle(l: TileLayer, cam: THREE.PerspectiveCamera, frames = 40) {
  for (let i = 0; i < frames; i++) l.update(cam, 1000);
}

describe("TileLayer level of detail", () => {
  it("far away: the 4k base texture is enough, nothing is downloaded", () => {
    const { l, urls } = layer();
    settle(l, camera(2.2));
    expect(urls).toHaveLength(0);
    expect(drawn(l)).toHaveLength(0);
  });

  it("close up: deep tiles, only on the visible side, bounded count", () => {
    const { l, urls } = layer();
    settle(l, camera(0.02)); // ≈ 35 km altitude over lon 0°, lat 0°
    const levels = urls.map(level);
    expect(Math.max(...levels)).toBeGreaterThanOrEqual(7);
    expect(drawn(l).length).toBeGreaterThan(0);
    expect(drawn(l).length).toBeLessThan(120);
    // Nothing requested on the far side (lon around 180°).
    expect(urls.some((u) => /\/\d+\/\d+\/0\.jpg$/.test(u) && level(u) >= 5)).toBe(false);
  });

  it("deeper zoom requests deeper levels", () => {
    const a = layer();
    settle(a.l, camera(0.3));
    const b = layer();
    settle(b.l, camera(0.02));
    expect(Math.max(...b.urls.map(level))).toBeGreaterThan(Math.max(...a.urls.map(level)));
  });

  it("polar view works (no NaN, tiles near the pole)", () => {
    const { l, urls } = layer();
    settle(l, camera(0.05, -89));
    expect(urls.length).toBeGreaterThan(0);
    for (const m of drawn(l)) expect(Number.isFinite(m.geometry.boundingSphere!.radius)).toBe(true);
  });

  it("network failures: status goes offline, nothing drawn, no throw", () => {
    const { l } = layer(true);
    let status = "";
    l.onStatus = (s) => (status = s);
    settle(l, camera(0.05));
    expect(status).toBe("offline");
    expect(drawn(l)).toHaveLength(0);
  });

  it("disabled: nothing requested", () => {
    const { l, urls } = layer();
    l.setEnabled(false);
    settle(l, camera(0.02));
    expect(urls).toHaveLength(0);
  });
});
