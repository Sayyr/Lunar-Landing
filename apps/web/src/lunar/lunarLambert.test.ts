import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { patchLunarLambert } from "./lunarLambert";

describe("patchLunarLambert", () => {
  it("rewrites three's real physical lighting chunk (diffuse replaced, direct specular removed)", () => {
    const out = patchLunarLambert(THREE.ShaderChunk.meshphysical_frag);
    expect(out).not.toContain("#include <lights_physical_pars_fragment>");
    expect(out).toContain("lunarLambertFactor( geometryNormal, directLight.direction, geometryViewDir )");
    expect(out).not.toContain("reflectedLight.directSpecular += irradiance * specularBRDF");
  });
});
