// First-person view from a lunar site: an observer standing on the surface looks around.
//
// Inputs are deliberately the ones the science service will provide: the terrain around the
// site (from the DEM) and the Sun / Earth AZIMUTH + ELEVATION at the site. Today the sky comes
// from the synthetic mock; swapping in SPICE results changes nothing here.
//
// Scene: metres, eye at the origin, x = East, y = Up, z = −North (groundTerrain.ts).
//   - terrain: LOLA relief at true scale (no exaggeration), uniform grey albedo, lit by the Sun
//     direction, with CAST SHADOWS from a GPU shadow map aligned on the Sun: receivers within
//     ±SHADOW_HALF of the observer's line toward the Sun, casters anywhere along that line up to
//     SHADOW_DEPTH away (a ridge 150 km toward the Sun can shadow the observer). Visual only —
//     the illumination maths belong to the science service;
//   - ideal geometric horizon (elevation 0°) drawn as a dashed circle, to compare with the relief;
//   - Sun and Earth at their mean angular sizes (0.53°, 1.9°), lit Earth shows its phase.
// Controls: drag to look around, wheel to zoom (field of view 5°–90°).

import * as THREE from "three";

import { bodyRotationToThree } from "../lib/sceneFrame";
import { makeSun } from "./globe";
import type { GroundTerrain } from "./groundTerrain";
import { DATA_BASE } from "./loaders";
import { type AzEl, azElToEnu } from "./skyGeometry";

const SKY_DIST = 1_500_000; // m, beyond the 400 km terrain
const SHADOW_HALF = 30_000; // m: shadow-map window half-width (4096 px → ≈ 15 m texels)
const SHADOW_DEPTH = 450_000; // m: light placed this far toward the Sun, casters up to there
const SUN_ANG_RADIUS = Math.atan(695_700 / 149_597_871);
const EARTH_ANG_RADIUS = Math.atan(6371 / 384_400);
const DEG = Math.PI / 180;

/** ENU → three.js (x = E, y = U, z = −N). */
const enuToThree = ([e, n, u]: number[]) => new THREE.Vector3(e, u, -n);

export interface GroundSky {
  sun: AzEl;
  earth: AzEl;
  /** Earth body-fixed → ENU, row-major 3×3 (optional texture orientation) */
  earthToEnu?: number[];
}

export interface GroundViewState {
  azimuthDeg: number;
  elevationDeg: number;
  hfovDeg: number;
}

export class GroundView {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly sunLight = new THREE.DirectionalLight(0xffffff, 3);
  private readonly fill = new THREE.HemisphereLight(0xb8c0d0, 0x000000, 0.6);
  private readonly sunBody: THREE.Group;
  private readonly earthBody: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  private readonly textures: THREE.Texture[] = [];
  private readonly resizeObserver: ResizeObserver;
  private terrain: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
  private az = 0;
  private el = 5;
  private listeners = new Set<(s: GroundViewState) => void>();
  private detachPointer: () => void;

  constructor(private readonly container: HTMLElement) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.scene.background = new THREE.Color(0x000000);

    this.camera = new THREE.PerspectiveCamera(60, container.clientWidth / Math.max(1, container.clientHeight), 0.3, 2 * SKY_DIST);

    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target); // stays at the eye (origin)
    const sh = this.sunLight.shadow;
    sh.mapSize.set(4096, 4096);
    Object.assign(sh.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: 1_000, far: 2 * SHADOW_DEPTH });
    sh.camera.updateProjectionMatrix();
    sh.bias = -0.0002;
    sh.normalBias = 15; // m, ≈ one texel: no acne on grazing slopes
    this.sunLight.castShadow = true;
    // Visual aid, NOT physical (no earthshine / scattered-light model): a sky-like hemisphere fill
    // so relief in shadow keeps a readable shape (slopes darken with their tilt). Toggleable.
    this.scene.add(this.fill);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.02));

    this.sunBody = makeSun(SKY_DIST * Math.tan(SUN_ANG_RADIUS), this.textures);
    this.sunBody.visible = false;
    this.scene.add(this.sunBody);

    this.earthBody = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_DIST * Math.tan(EARTH_ANG_RADIUS), 48, 32),
      new THREE.MeshStandardMaterial({ color: 0x5b8ff8, emissive: 0x1a2a55, roughness: 0.9, metalness: 0 }),
    );
    this.earthBody.visible = false;
    this.scene.add(this.earthBody);
    new THREE.TextureLoader().load(`${DATA_BASE}earth_bluemarble_2048.png`, (tex) => {
      if (!this.renderer.domElement.isConnected) return tex.dispose();
      tex.colorSpace = THREE.SRGBColorSpace;
      this.textures.push(tex);
      const m = this.earthBody.material;
      m.map = tex;
      m.color.setScalar(1.8); // brighter than physical, for visibility (as in the orbit view)
      m.emissiveMap = tex;
      m.emissive.set(0xffffff);
      m.emissiveIntensity = 0.12;
      m.needsUpdate = true;
    });

    this.scene.add(idealHorizon());

    this.detachPointer = this.attachLook();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.applyLook();
    renderer.setAnimationLoop(() => renderer.render(this.scene, this.camera));
  }

  setTerrain(t: GroundTerrain): void {
    if (this.terrain) {
      this.terrain.geometry.dispose();
      this.terrain.material.dispose();
      this.scene.remove(this.terrain);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(t.positions, 3));
    g.setIndex(new THREE.BufferAttribute(t.indices, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    this.terrain = new THREE.Mesh(
      g,
      new THREE.MeshStandardMaterial({ color: 0x8f8f8f, roughness: 1, metalness: 0, side: THREE.DoubleSide }),
    );
    this.terrain.castShadow = true;
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
  }

  setSky(sky: GroundSky | null): void {
    this.sunBody.visible = this.earthBody.visible = sky !== null;
    if (!sky) return;
    const sun = enuToThree(azElToEnu(sky.sun));
    const earth = enuToThree(azElToEnu(sky.earth));
    this.sunLight.position.copy(sun).multiplyScalar(SHADOW_DEPTH);
    this.sunBody.position.copy(sun).multiplyScalar(SKY_DIST);
    this.earthBody.position.copy(earth).multiplyScalar(SKY_DIST);
    if (sky.earthToEnu) this.earthBody.quaternion.setFromRotationMatrix(bodyRotationToThree(sky.earthToEnu));
  }

  /** Visual-aid fill light on/off (off = only the Sun lights the terrain, as on the Moon). */
  setFill(on: boolean): void {
    this.fill.visible = on;
  }

  /** Point the view at an azimuth / elevation (degrees). */
  look(azimuthDeg: number, elevationDeg: number): void {
    this.az = ((azimuthDeg % 360) + 360) % 360;
    this.el = THREE.MathUtils.clamp(elevationDeg, -80, 85);
    this.applyLook();
  }

  onView(cb: (s: GroundViewState) => void): () => void {
    this.listeners.add(cb);
    cb(this.state());
    return () => this.listeners.delete(cb);
  }

  setActive(active: boolean): void {
    this.renderer.setAnimationLoop(active ? () => this.renderer.render(this.scene, this.camera) : null);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.detachPointer();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    for (const t of this.textures) t.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private state(): GroundViewState {
    const hfov = 2 * Math.atan(Math.tan((this.camera.fov * DEG) / 2) * this.camera.aspect);
    return { azimuthDeg: this.az, elevationDeg: this.el, hfovDeg: hfov / DEG };
  }

  private applyLook(): void {
    const dir = enuToThree(azElToEnu({ azimuthDeg: this.az, elevationDeg: this.el }));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(dir);
    this.camera.updateProjectionMatrix();
    const s = this.state();
    this.listeners.forEach((l) => l(s));
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.applyLook();
  }

  /** Drag = look around (grab the sky), wheel = zoom (field of view). */
  private attachLook(): () => void {
    const el = this.renderer.domElement;
    let last: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!last) return;
      const degPerPx = this.camera.fov / el.clientHeight;
      this.look(this.az - (e.clientX - last.x) * degPerPx, this.el + (e.clientY - last.y) * degPerPx);
      last = { x: e.clientX, y: e.clientY };
    };
    const up = () => (last = null);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.camera.fov = THREE.MathUtils.clamp(this.camera.fov * Math.exp(e.deltaY * 0.001), 5, 90);
      this.applyLook();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
    };
  }
}

/** Dashed circle at elevation 0° (ideal geometric horizon of the reference sphere's tangent plane). */
function idealHorizon(): THREE.Line {
  const pts: THREE.Vector3[] = [];
  for (let a = 0; a <= 360; a += 1) pts.push(enuToThree(azElToEnu({ azimuthDeg: a, elevationDeg: 0 })).multiplyScalar(SKY_DIST * 0.9));
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color: 0x7fd4ff, dashSize: 12_000, gapSize: 9_000, transparent: true, opacity: 0.5 }),
  );
  line.computeLineDistances();
  return line;
}
