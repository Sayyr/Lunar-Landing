import * as THREE from "three";

const MCEWEN = { a: -0.019, b: 0.242e-3, c: -1.46e-6 };

const SPECULAR_LINE = "reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;";
const DIFFUSE_LINE = "reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );";

const GLSL = `
float lunarLambertFactor( const in vec3 n, const in vec3 l, const in vec3 v ) {
  float mu0 = saturate( dot( n, l ) );
  float mu = saturate( dot( n, v ) );
  float g = degrees( acos( clamp( dot( l, v ), -1.0, 1.0 ) ) );
  float L = clamp( 1.0 + ${MCEWEN.a} * g + ${MCEWEN.b.toExponential()} * g * g + ${MCEWEN.c.toExponential()} * g * g * g, 0.0, 1.0 );
  return ( 1.0 - L ) + 2.0 * L / max( mu0 + mu, 1e-4 );
}
`;

export function patchLunarLambert(fragmentShader: string): string {
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  if (!chunk.includes(SPECULAR_LINE) || !chunk.includes(DIFFUSE_LINE)) {
    console.warn("lunar-Lambert: three's lighting chunk changed, falling back to Lambert");
    return fragmentShader;
  }
  const patched = chunk
    .replace(SPECULAR_LINE, "")
    .replace(
      DIFFUSE_LINE,
      "reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * lunarLambertFactor( geometryNormal, directLight.direction, geometryViewDir );",
    );
  return fragmentShader.replace("#include <lights_physical_pars_fragment>", GLSL + patched);
}
