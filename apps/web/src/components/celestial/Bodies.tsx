// 3D models of the Sun, Earth and Moon. Appearance only: positions and orientations are passed in
// from the celestial state (API, SPICE); nothing here computes astronomy.

import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { type ReactNode, useMemo, useRef } from "react";
import {
  AdditiveBlending,
  CanvasTexture,
  type Matrix4,
  type ShaderMaterial,
  type Texture,
  Quaternion,
} from "three";

import type { V3 } from "../../lib/sceneFrame";

function Label({ children, offset }: { children: ReactNode; offset: number }) {
  return (
    <Html position={[0, offset, 0]} center className="body-label" zIndexRange={[10, 0]}>
      {children}
    </Html>
  );
}

// ---------------------------------------------------------------- Sun (procedural, no texture)

// Shared by the Sun and the atmosphere (the atmosphere ignores vLocal).
const BODY_VERT = /* glsl */ `
  varying vec3 vLocal;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  void main() {
    vLocal = position;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// Value-noise fbm for granulation-like texture + a limb-darkening factor. Purely cosmetic.
const SUN_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec3 vLocal;
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
      f.z);
  }
  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
  void main() {
    vec3 p = normalize(vLocal) * 5.0;
    float g = 0.6 * fbm(p + vec3(uTime * 0.04)) + 0.4 * fbm(p * 3.1 - vec3(uTime * 0.07));
    float mu = clamp(dot(normalize(vNormalW), normalize(vViewDir)), 0.0, 1.0);
    float limb = 0.35 + 0.65 * pow(mu, 0.45);
    vec3 cool = vec3(0.95, 0.42, 0.06);
    vec3 hot = vec3(1.0, 0.95, 0.7);
    gl_FragColor = vec4(mix(cool, hot, smoothstep(0.3, 0.75, g)) * limb * 1.35, 1.0);
  }
`;

function makeGlowTexture(): CanvasTexture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,240,200,1)");
  grad.addColorStop(0.18, "rgba(255,200,90,0.75)");
  grad.addColorStop(0.45, "rgba(255,140,40,0.18)");
  grad.addColorStop(1, "rgba(255,120,20,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new CanvasTexture(c);
}

export function Sun({ position, radius, glowScale, label }: { position: V3; radius: number; glowScale: number; label?: string }) {
  const mat = useRef<ShaderMaterial>(null);
  const uniforms = useMemo(() => ({ uTime: { value: 0 } }), []);
  const glow = useMemo(makeGlowTexture, []);
  useFrame((_, dt) => {
    if (mat.current) mat.current.uniforms.uTime.value += dt;
  });
  return (
    <group position={position}>
      {/* unit sphere + scale: the radius changes every tick in play mode, geometry args would rebuild */}
      <mesh scale={radius}>
        <sphereGeometry args={[1, 64, 48]} />
        <shaderMaterial ref={mat} uniforms={uniforms} vertexShader={BODY_VERT} fragmentShader={SUN_FRAG} toneMapped={false} />
      </mesh>
      <sprite scale={[glowScale, glowScale, 1]}>
        <spriteMaterial map={glow} blending={AdditiveBlending} depthWrite={false} transparent toneMapped={false} />
      </sprite>
      {label && <Label offset={Math.max(radius * 1.6, glowScale * 0.22)}>{label}</Label>}
    </group>
  );
}

// ---------------------------------------------------------------- Earth

const ATMO_FRAG = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vViewDir;
  void main() {
    float rim = pow(1.0 - max(dot(normalize(vNormalW), normalize(vViewDir)), 0.0), 3.0);
    gl_FragColor = vec4(0.35, 0.62, 1.0, rim * 0.85);
  }
`;

export function Earth({
  position,
  radius,
  orientation,
  texture,
  label,
}: {
  position: V3;
  radius: number;
  /** body-fixed → three world rotation */
  orientation: Matrix4;
  texture: Texture | null;
  label?: string;
}) {
  const quaternion = useMemo(() => new Quaternion().setFromRotationMatrix(orientation), [orientation]);
  return (
    <group position={position}>
      <mesh quaternion={quaternion}>
        <sphereGeometry args={[radius, 96, 64]} />
        {texture ? (
          <meshStandardMaterial map={texture} roughness={0.85} metalness={0} />
        ) : (
          <meshStandardMaterial color="#2f6db5" roughness={0.85} metalness={0} />
        )}
      </mesh>
      {/* Rotation axis, to make the tilt readable. */}
      <mesh quaternion={quaternion}>
        <cylinderGeometry args={[radius * 0.012, radius * 0.012, radius * 2.6, 6]} />
        <meshBasicMaterial color="#9fc6ff" transparent opacity={0.6} />
      </mesh>
      <mesh scale={1.035}>
        <sphereGeometry args={[radius, 64, 48]} />
        <shaderMaterial vertexShader={BODY_VERT} fragmentShader={ATMO_FRAG} transparent blending={AdditiveBlending} depthWrite={false} />
      </mesh>
      {label && <Label offset={radius * 1.9}>{label}</Label>}
    </group>
  );
}

// ---------------------------------------------------------------- Moon

export function Moon({
  position,
  radius,
  orientation,
  texture,
  label,
}: {
  position: V3;
  radius: number;
  /** body-fixed → three world rotation */
  orientation: Matrix4;
  texture: Texture | null;
  label?: string;
}) {
  const quaternion = useMemo(() => new Quaternion().setFromRotationMatrix(orientation), [orientation]);
  return (
    <group position={position}>
      <mesh quaternion={quaternion}>
        <sphereGeometry args={[radius, 64, 48]} />
        {texture ? (
          <meshStandardMaterial map={texture} roughness={1} metalness={0} />
        ) : (
          <meshStandardMaterial color="#9a9a9a" roughness={1} metalness={0} />
        )}
      </mesh>
      {label && <Label offset={radius * 2.2}>{label}</Label>}
    </group>
  );
}
