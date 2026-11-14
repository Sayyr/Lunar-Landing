// First-person view from a lunar site: an observer standing on the surface looks around.
//
// Inputs are deliberately the ones the science service will provide: the terrain around the
// site (from the DEM) and the Sun / Earth AZIMUTH + ELEVATION at the site. Today the sky comes
// from the synthetic mock; swapping in SPICE results changes nothing here.
//
// Scene: metres, eye at the origin, x = East, y = Up, z = −North (groundTerrain.ts).
//   - terrain: LOLA relief at true scale, colour mosaic × procedural regolith detail, lit by the
//     Sun direction, with CAST SHADOWS from a GPU shadow map aligned on the Sun: receivers within
//     ±SHADOW_HALF of the observer's line toward the Sun, casters anywhere along that line up to
//     SHADOW_DEPTH away (a ridge 150 km toward the Sun can shadow the observer). Visual only —
//     the illumination maths belong to the science service;
//   - ideal geometric horizon (elevation 0°) drawn as a dashed circle, to compare with the relief;
//   - Sun and Earth at their mean angular sizes (0.53°, 1.9°), lit Earth shows its phase.
// Controls: drag to look around, wheel to zoom (field of view 5°–90°). Nothing animates, so frames
// are rendered on demand and the shadow map is redrawn only when the Sun or the terrain changes.

import * as THREE from "three";

import { bodyRotationToThree } from "../lib/sceneFrame";
import { DEG } from "../lib/constants";
import { makeSun } from "./globe";
import { SUN_ANG_RADIUS } from "./groundAuto";
import type { GroundTerrain } from "./groundTerrain";
import { DATA_BASE } from "./loaders";
import { WANG_LAYERS, type WangBank } from "./wangBank";
import { type AzEl, azElToEnu, wrap360 } from "./skyGeometry";

const SKY_DIST = 1_500_000; // m, beyond the 400 km terrain
const SHADOW_HALF = 30_000; // m: shadow-map window half-width (4096 px → ≈ 15 m texels)
const SHADOW_DEPTH = 450_000; // m: light placed this far toward the Sun, casters up to there
const EARTH_ANG_RADIUS = Math.atan(6371 / 384_400); // mean, seen from the Moon

const WHITE = new Uint8Array([255, 255, 255, 255]);

/**
 * GLSL assembly of the Wang bank: integer hashes of the cell's four edges give their colours,
 * hence the tile layer; shared edges hash identically from both cells, so neighbours match.
 * textureGrad with the continuous UV derivatives avoids mip seams at cell borders.
 */
const WANG_GLSL = `
uniform highp sampler2DArray bankAR;
uniform highp sampler2DArray bankN;
uniform float detailMean;
uniform float detailOn;
uint wangHash( ivec2 p, uint salt ) {
  uvec2 q = uvec2( p ) * uvec2( 1597334673u, 3812015801u );
  uint n = ( q.x ^ q.y ^ salt ) * 1597334673u;
  return n ^ ( n >> 16u );
}
float wangLayer( vec2 uv, uint salt ) {
  ivec2 c = ivec2( floor( uv ) );
  uint n = wangHash( c + ivec2( 0, 1 ), salt ) & 1u;           // horizontal edge above (north)
  uint s = wangHash( c, salt ) & 1u;                             // horizontal edge below (south)
  uint e = wangHash( c + ivec2( 1, 0 ), salt + 7919u ) & 1u;     // vertical edge right (east)
  uint w = wangHash( c, salt + 7919u ) & 1u;                     // vertical edge left (west)
  return float( n | ( e << 1u ) | ( s << 2u ) | ( w << 3u ) );   // = wangLayer(n, e, s, w) in wangBank.ts
}
vec4 wangSample( highp sampler2DArray t, vec2 uv, uint salt ) {
  return textureGrad( t, vec3( fract( uv ), wangLayer( uv, salt ) ), dFdx( uv ), dFdy( uv ) );
}
`;

/** Applies shader text replacements, failing loudly if three's chunks changed (upgrade guard). */
function patch(src: string, ...pairs: [string, string][]): string {
  for (const [from, to] of pairs) {
    if (!src.includes(from)) throw new Error(`ground shader patch: "${from.slice(0, 40)}…" not found (three.js changed?)`);
    src = src.replace(from, to);
  }
  return src;
}

/** One bank per page, generated in a worker (deterministic, ~2 s). */
let bankPromise: Promise<WangBank> | null = null;
function loadWangBank(): Promise<WangBank> {
  return (bankPromise ??= new Promise<WangBank>((resolve, reject) => {
    const w = new Worker(new URL("./wangBank.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<WangBank>) => {
      resolve(e.data);
      w.terminate();
    };
    w.onerror = (e) => {
      reject(new Error(e.message));
      w.terminate();
    };
    w.postMessage(null); // defaults of generateWangBank
  }));
}

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
  private readonly ground: THREE.MeshStandardMaterial;
  private detail!: {
    bankAR: { value: THREE.DataArrayTexture };
    bankN: { value: THREE.DataArrayTexture };
    detailMean: { value: number };
    detailOn: { value: number };
  };
  private az = 0;
  private el = 5;
  private listeners = new Set<(s: GroundViewState) => void>();
  private readonly pointer = new AbortController();
  private active = true;
  private frameQueued = false;

  constructor(private readonly container: HTMLElement) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft was removed in r18x; softened via shadow.radius
    renderer.shadowMap.autoUpdate = false; // redrawn only when the Sun or the terrain changes
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
    sh.radius = 2.5; // PCF blur: less streaking under a grazing Sun
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
      this.requestRender();
    });

    this.scene.add(idealHorizon());
    this.ground = this.makeGroundMaterial();

    this.attachLook();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.applyLook();
  }

  /** Uploads on first use and frees it with the view. */
  private track<T extends THREE.Texture>(t: T): T {
    t.needsUpdate = true;
    this.textures.push(t);
    return t;
  }

  /** Renders once on the next animation frame (coalesced; nothing while inactive). */
  private requestRender(): void {
    if (!this.active || this.frameQueued) return;
    this.frameQueued = true;
    requestAnimationFrame(() => {
      this.frameQueued = false;
      if (this.active) this.renderer.render(this.scene, this.camera);
    });
  }

  setTerrain(t: GroundTerrain): void {
    if (this.terrain) {
      this.terrain.geometry.dispose();
      this.scene.remove(this.terrain);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(t.positions, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(t.uvs, 2));
    if (t.colors) g.setAttribute("color", new THREE.BufferAttribute(t.colors, 3));
    g.setIndex(new THREE.BufferAttribute(t.indices, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    if (this.ground.vertexColors !== !!t.colors) {
      this.ground.vertexColors = !!t.colors;
      this.ground.color.set(t.colors ? 0xffffff : 0x9a9a9a);
      this.ground.needsUpdate = true;
    }
    this.terrain = new THREE.Mesh(g, this.ground);
    this.terrain.castShadow = true;
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
    this.renderer.shadowMap.needsUpdate = true;
    this.requestRender();
  }

  setSky(sky: GroundSky | null): void {
    this.sunBody.visible = this.earthBody.visible = sky !== null;
    this.renderer.shadowMap.needsUpdate = true;
    this.requestRender();
    if (!sky) return;
    const sun = enuToThree(azElToEnu(sky.sun));
    const earth = enuToThree(azElToEnu(sky.earth));
    this.sunLight.position.copy(sun).multiplyScalar(SHADOW_DEPTH);
    this.sunBody.position.copy(sun).multiplyScalar(SKY_DIST);
    this.earthBody.position.copy(earth).multiplyScalar(SKY_DIST);
    if (sky.earthToEnu) this.earthBody.quaternion.setFromRotationMatrix(bodyRotationToThree(sky.earthToEnu));
  }

  /**
   * Ground material: large-scale colour from the vertex colours (real colour mosaic) × close-up
   * detail from the Wang tile bank (wangBank.ts, ILLUSTRATIVE), assembled in the shader: each
   * cell of the 4 m grid takes the tile whose edge colours match hashes of its four edges, so
   * neighbours always connect and nothing repeats periodically. Sampled at three scales (4 m,
   * ≈ 48 m, ≈ 560 m) for albedo; normal and roughness at 4 m. Metalness 0 (regolith is a
   * non-metal). Fine albedo and normals fade where a pixel covers ≳ 1 m (no far-field shimmer).
   * Until the bank arrives from its worker, the ground is plain (detailOn = 0).
   */
  private makeGroundMaterial(): THREE.MeshStandardMaterial {
    const placeholder = this.track(new THREE.DataArrayTexture(WHITE, 1, 1, 1));
    this.detail = {
      bankAR: { value: placeholder },
      bankN: { value: placeholder },
      detailMean: { value: 1 },
      detailOn: { value: 0 },
    };
    // 1×1 stand-ins only switch on three's map / normal-map / roughness-map shader paths (and
    // their UV varyings); the patched shader samples the tile bank instead.
    const stand = () => this.track(new THREE.DataTexture(WHITE, 1, 1));
    const m = new THREE.MeshStandardMaterial({
      color: 0x9a9a9a,
      map: stand(),
      normalMap: stand(),
      roughnessMap: stand(),
      roughness: 1, // multiplied by the bank's roughness
      metalness: 0, // non-metal: no metalness map
      side: THREE.DoubleSide,
    });
    // Patched once, here (during construction): if three's chunks ever change, the error is
    // thrown while the view mounts — where GroundViewBoundary catches it — not every frame.
    const fragmentShader = patch(
      THREE.ShaderLib.standard.fragmentShader,
      ["#include <map_pars_fragment>", `#include <map_pars_fragment>\n${WANG_GLSL}`],
      [
        "#include <map_fragment>",
        `#ifdef USE_MAP
          float fine = clamp( 1.0 - 4.0 * length( fwidth( vMapUv ) ), 0.0, 1.0 ) * detailOn;
          vec3 d1 = mix( vec3( detailMean ), wangSample( bankAR, vMapUv, 0u ).rgb, 0.7 * fine );
          vec3 d2 = mix( vec3( detailMean ), wangSample( bankAR, vMapUv * 0.083 + vec2( 0.37, 0.71 ), 101u ).rgb, 0.45 * detailOn );
          vec3 d3 = mix( vec3( detailMean ), wangSample( bankAR, vMapUv * 0.0071 + vec2( 0.13, 0.29 ), 211u ).rgb, 0.35 * detailOn );
          diffuseColor.rgb *= d1 * d2 * d3 / ( detailMean * detailMean * detailMean );
        #endif`,
      ],
      // onBeforeCompile sees "#include <chunk>" lines, not their code: inline the chunk, patched.
      [
        "#include <normal_fragment_maps>",
        patch(
          THREE.ShaderChunk.normal_fragment_maps,
          [
            "vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
            "vec3 mapN = mix( vec3( 0.5, 0.5, 1.0 ), wangSample( bankN, vNormalMapUv, 0u ).xyz, detailOn ) * 2.0 - 1.0;",
          ],
          ["mapN.xy *= normalScale;", "mapN.xy *= normalScale * clamp( 1.0 - 4.0 * length( fwidth( vNormalMapUv ) ), 0.0, 1.0 );"],
        ),
      ],
      [
        "#include <roughnessmap_fragment>",
        patch(THREE.ShaderChunk.roughnessmap_fragment, [
          "vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );",
          "vec4 texelRoughness = vec4( 1.0, mix( 1.0, wangSample( bankAR, vRoughnessMapUv, 0u ).a, detailOn ), 1.0, 1.0 );",
        ]),
      ],
    );
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.detail);
      shader.fragmentShader = fragmentShader;
    };
    m.customProgramCacheKey = () => "ground-wang";
    loadWangBank()
      .then((bank) => this.applyBank(bank))
      .catch((e) => console.warn("Regolith tile bank unavailable, plain ground:", e));
    return m;
  }

  private applyBank(bank: WangBank): void {
    if (!this.renderer.domElement.isConnected) return; // view disposed meanwhile
    const arr = (data: Uint8Array, srgb: boolean) => {
      const t = new THREE.DataArrayTexture(data, bank.size, bank.size, WANG_LAYERS);
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      if (srgb) t.colorSpace = THREE.SRGBColorSpace; // RGB albedo decoded to linear; alpha (roughness) untouched
      return this.track(t);
    };
    this.detail.bankAR.value = arr(bank.albedoRough, true);
    this.detail.bankN.value = arr(bank.normal, false);
    this.detail.detailMean.value = bank.meanLinear;
    this.detail.detailOn.value = 1;
    this.requestRender();
  }

  /** Visual-aid fill light on/off (off = only the Sun lights the terrain, as on the Moon). */
  setFill(on: boolean): void {
    this.fill.visible = on;
    this.requestRender();
  }

  /** Point the view at an azimuth / elevation (degrees). */
  look(azimuthDeg: number, elevationDeg: number): void {
    this.az = wrap360(azimuthDeg);
    this.el = THREE.MathUtils.clamp(elevationDeg, -80, 85);
    this.applyLook();
  }

  onView(cb: (s: GroundViewState) => void): () => void {
    this.listeners.add(cb);
    cb(this.state());
    return () => this.listeners.delete(cb);
  }

  setActive(active: boolean): void {
    this.active = active;
    this.requestRender();
  }

  dispose(): void {
    this.active = false;
    this.resizeObserver.disconnect();
    this.pointer.abort();
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
    this.requestRender();
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
  private attachLook(): void {
    const el = this.renderer.domElement;
    const opts = { signal: this.pointer.signal };
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
    el.addEventListener("pointerdown", down, opts);
    el.addEventListener("pointermove", move, opts);
    el.addEventListener("pointerup", up, opts);
    el.addEventListener("pointercancel", up, opts);
    el.addEventListener("wheel", wheel, { ...opts, passive: false });
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
