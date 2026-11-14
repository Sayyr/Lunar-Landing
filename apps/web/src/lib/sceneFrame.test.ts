import { Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { earthFixedToEcliptic } from "../mock/lowPrecisionEphemeris";
import { latLonToUnit } from "../lunar/geo";
import { bodyRotationToThree, eclToThree } from "./sceneFrame";

describe("eclToThree", () => {
  it("maps the ecliptic plane onto the Three.js XZ plane", () => {
    expect(eclToThree([1, 0, 0])).toEqual([1, 0, -0]);
    expect(eclToThree([0, 1, 0])).toEqual([0, 0, -1]);
    expect(eclToThree([0, 0, 1])).toEqual([0, 1, -0]);
    expect(eclToThree([2, 0, 0], 0.5)).toEqual([1, 0, -0]);
  });
});

describe("bodyRotationToThree", () => {
  it("identity stays identity", () => {
    const m = bodyRotationToThree([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    m.elements.forEach((x, i) => expect(x).toBeCloseTo(id[i], 15)); // toBeCloseTo treats −0 == 0
  });

  it("agrees with applying the body→ecliptic matrix and then eclToThree", () => {
    const m = earthFixedToEcliptic(2461000.25, 2461000.25);
    const R = bodyRotationToThree(m);
    for (const [lat, lon] of [[0, 0], [0, 90], [45, -120], [-60, 10], [90, 0]]) {
      const local = latLonToUnit(lat, lon); // mesh-local point, same Y-up convention
      const world = new Vector3(local.x, local.y, local.z).applyMatrix4(R);
      const latR = (lat * Math.PI) / 180, lonR = (lon * Math.PI) / 180;
      const body = [Math.cos(latR) * Math.cos(lonR), Math.cos(latR) * Math.sin(lonR), Math.sin(latR)];
      const ecl = [
        m[0] * body[0] + m[1] * body[1] + m[2] * body[2],
        m[3] * body[0] + m[4] * body[1] + m[5] * body[2],
        m[6] * body[0] + m[7] * body[1] + m[8] * body[2],
      ];
      const want = eclToThree(ecl);
      expect(world.x).toBeCloseTo(want[0], 12);
      expect(world.y).toBeCloseTo(want[1], 12);
      expect(world.z).toBeCloseTo(want[2], 12);
    }
  });
});
