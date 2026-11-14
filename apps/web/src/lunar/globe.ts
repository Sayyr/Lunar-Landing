// three.js scene: textured, displaced Moon, lat/lon grid, markers, picking.
// Ported from apps/moon-explorer/js/globe.js. Changes for the React app:
//   - colour image and heightmap are optional (untextured / undisplaced fallback when the data
//     has not been installed with scripts/setup-data.sh) so the scenario UI keeps working;
//   - sizes follow the container (ResizeObserver) and `dispose()` frees GPU resources on unmount;
//   - `setSite()` shows the scenario's selected site as a distinct marker;
//   - `setLandingSites()` shows past soft-landing sites as fixed-size points (LROC coordinates);
//   - `setSky()` places the Sun and Earth in the background and points the light at the Sun.
//
// Scene units: 1 unit = reference radius (1737.4 km). The elevation raster is in km, so the
// displacement scale is exaggeration / 1737.4.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { bodyRotationToThree } from "../lib/sceneFrame";
import { latLonToUnit, MOON_RADIUS_KM, pointToUv, uvToLatLon } from "./geo";
import type { Heightmap } from "./heightmap";
import { DATA_BASE } from "./loaders";
import type { MoonSky, Vec3 } from "./skyGeometry";
import { TILE_STENCIL, TileLayer, type TileStatus } from "./tileLayer";

// Background bodies are drawn at SKY_DIST from the camera (always "at infinity": no parallax when
// orbiting) with their true mean angular radii as seen from the Moon.
const SKY_DIST = 60;
const EARTH_ANG_RADIUS = Math.atan(6371 / 384_400); // ≈ 0.95°
const SUN_ANG_RADIUS = Math.atan(695_700 / 149_597_871); // ≈ 0.27°
// Sun–Moon–camera angle i on load: lit fraction of the disc k = (1 + cos i) / 2 = 0.8 → i ≈ 53.1°
// (formula for a distant viewer; from 3.2 radii it is within a few percent).
const LOAD_PHASE_ANGLE = Math.acos(2 * 0.8 - 1);
// On-screen marker radii (CSS px), constant whatever the zoom (see sizeMarkers).
const SITE_MARKER_PX = 7;
const CLICK_MARKER_PX = 4;
const CAMERA_MOVE_EPS_SQ = 1e-18;
// Moon body frame (x lon 0, y lon 90° E, z north) → three.js (x, z, −y), as lunar/geo.ts.
const bodyToThree = (v: Vec3) => new THREE.Vector3(v[0], v[2], -v[1]);

export interface PickResult {
  lat: number;
  lon: number;
  /** null when no elevation raster is loaded */
  altM: number | null;
}

export interface GlobeOptions {
  colorImage: HTMLImageElement | null;
  heightmap: Heightmap | null;
  /** segments in longitude (half as many in latitude) */
  segments: number;
  /** initial camera direction */
  initialView?: { lat: number; lon: number };
}

/** A layer draped over the displayed surface (e.g. the slope filter), kept in step with the relief scale. */
export interface SurfaceOverlay {
  readonly object: THREE.Object3D;
  setScale(scale: number): void;
  dispose(): void;
  /** Set by the globe (it renders on demand): the layer calls it whenever its appearance changes. */
  onChange?: () => void;
}

export class Globe {
  readonly renderer: THREE.WebGLRenderer;
  readonly floatLinear: boolean;
  exaggeration = 1;
  refinePick = true;

  private readonly container: HTMLElement;
  private readonly heightmap: Heightmap | null;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  private readonly grid: THREE.Group;
  private readonly markers = new THREE.Group();
  private landings: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> | null = null;
  private readonly siteMarker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly textures: THREE.Texture[] = [];
  private readonly resizeObserver: ResizeObserver;
  private ring: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
  private flight: { from: THREE.Vector3; to: THREE.Vector3; d0: number; d1: number; t0: number; dur: number } | null = null;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly sunBody: THREE.Group;
  private readonly earthBody: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  private sky: { sun: THREE.Vector3; earth: THREE.Vector3 } | null = null;
  private framedOnSun = false;
  private readonly tiles: TileLayer;
  private readonly heightTex: THREE.DataTexture | null;
  private readonly overlays = new Set<SurfaceOverlay>();
  private active = true;
  private dragging = false;
  private frameId = 0;
  private readonly requestRender = (): void => {
    if (!this.active || this.frameId) return;
    this.frameId = requestAnimationFrame((t) => this.frame(t));
  };

  constructor(container: HTMLElement, { colorImage, heightmap, segments, initialView }: GlobeOptions) {
    this.container = container;
    this.heightmap = heightmap;

    // --- Rendering ---------------------------------------------------------------------------
    // stencil: tiles mark their pixels so the coarser base mesh cannot draw over them (see TileLayer).
    const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 0.001, 100);
    const v = initialView ?? { lat: 10, lon: 0 }; // moon-explorer default: facing lon 0°, ~10° N
    const u = latLonToUnit(Math.max(-60, Math.min(60, v.lat)), v.lon);
    camera.position.set(u.x, u.y, u.z).multiplyScalar(3.2);
    this.camera = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 1.08;
    controls.maxDistance = 8;
    controls.rotateSpeed = 0.5;
    this.controls = controls;
    // Rotation slows down near the surface (proportional to altitude) so close-ups stay usable.
    controls.addEventListener("change", () => {
      const alt = camera.position.length() - 1;
      controls.rotateSpeed = Math.min(0.5, Math.max(0.02, alt * 0.8));
      controls.zoomSpeed = Math.min(1, Math.max(0.3, alt * 2));
    });
    controls.addEventListener("change", this.requestRender);
    controls.addEventListener("start", () => {
      this.dragging = true;
      this.requestRender();
    });
    controls.addEventListener("end", () => {
      this.dragging = false;
    });
    renderer.domElement.addEventListener("webglcontextrestored", this.requestRender);

    // --- Lighting: directional "Sun". Fixed illustrative direction until setSky() is called. -----
    const sun = new THREE.DirectionalLight(0xffffff, 3.0);
    sun.position.set(5, 1.5, 3);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0xffffff, 0.06));
    this.sunLight = sun;

    // --- Background Sun and Earth (hidden until setSky) ---------------------------------------------
    this.sunBody = makeSun(SKY_DIST * Math.tan(SUN_ANG_RADIUS), this.textures);
    this.sunBody.visible = false;
    scene.add(this.sunBody);
    this.earthBody = new THREE.Mesh(
      new THREE.SphereGeometry(SKY_DIST * Math.tan(EARTH_ANG_RADIUS), 48, 32),
      new THREE.MeshStandardMaterial({ color: 0x5b8ff8, emissive: 0x1a2a55, roughness: 0.9, metalness: 0 }),
    );
    this.earthBody.matrixAutoUpdate = false;
    this.earthBody.visible = false;
    scene.add(this.earthBody);
    // Optional texture (installed by scripts/setup-data.sh); plain blue sphere otherwise.
    new THREE.TextureLoader().load(`${DATA_BASE}earth_bluemarble_2048.png`, (tex) => {
      if (!this.renderer.domElement.isConnected) return tex.dispose(); // globe disposed meanwhile
      tex.colorSpace = THREE.SRGBColorSpace;
      this.textures.push(tex);
      const m = this.earthBody.material;
      m.map = tex;
      // Brighter than physical (visibility): day side ×1.8, faint glow so the night side stays readable.
      m.color.setScalar(1.8);
      m.emissiveMap = tex;
      m.emissive.set(0xffffff);
      m.emissiveIntensity = 0.12;
      m.needsUpdate = true;
      this.requestRender();
    });

    // --- Textures -------------------------------------------------------------------------------
    let colorTex: THREE.Texture | null = null;
    if (colorImage) {
      colorTex = new THREE.Texture(colorImage);
      colorTex.colorSpace = THREE.SRGBColorSpace;
      colorTex.wrapS = THREE.RepeatWrapping;
      colorTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      colorTex.needsUpdate = true;
      this.textures.push(colorTex);
    }

    // Float DataTexture over the raster's Float32Array (no CPU copy): rows were flipped in place
    // at load time (row 0 = south = v 0).
    // float32 linear filtering isn't guaranteed (mobile): fall back to Nearest.
    const linearOk = renderer.extensions.has("OES_texture_float_linear");
    this.floatLinear = linearOk;
    let heightTex: THREE.DataTexture | null = null;
    if (heightmap) {
      const { data, width, height } = heightmap;
      heightTex = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.FloatType);
      heightTex.wrapS = THREE.RepeatWrapping; // seamless at ±180°
      heightTex.wrapT = THREE.ClampToEdgeWrapping;
      heightTex.magFilter = linearOk ? THREE.LinearFilter : THREE.NearestFilter;
      heightTex.minFilter = linearOk ? THREE.LinearFilter : THREE.NearestFilter;
      heightTex.generateMipmaps = false;
      heightTex.flipY = false;
      heightTex.needsUpdate = true;
      this.textures.push(heightTex);
    }
    this.heightTex = heightTex;

    // --- Sphere ---------------------------------------------------------------------------------
    const geometry = new THREE.SphereGeometry(1, segments, segments / 2);
    const material = new THREE.MeshStandardMaterial({
      map: colorTex,
      color: colorTex ? 0xffffff : 0x8d8d8d,
      displacementMap: heightTex,
      // The same raster doubles as bumpMap: shading follows the relief without recomputing
      // normals or another texture in memory.
      bumpMap: heightTex,
      roughness: 1,
      metalness: 0,
    });
    // Drawn after the tiles and only where no tile wrote the stencil: in concave terrain the base
    // mesh's long chords sit above the finer tile surface and would otherwise show through.
    material.stencilWrite = true;
    material.stencilRef = TILE_STENCIL;
    material.stencilFunc = THREE.NotEqualStencilFunc;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);

    // --- Lat/lon grid, markers, selection ring ---------------------------------------------------
    this.grid = makeGrid();
    this.grid.visible = false;
    scene.add(this.grid);
    scene.add(this.markers);

    this.siteMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xff5a5f }),
    );
    this.siteMarker.visible = false;
    scene.add(this.siteMarker);

    // --- Streaming high-resolution imagery (NASA Moon Trek), over the base mesh ------------------
    this.tiles = new TileLayer(heightmap, heightTex, renderer.capabilities.getMaxAnisotropy(), colorImage?.width ?? 0);
    this.tiles.onChange = this.requestRender;
    scene.add(this.tiles.group);

    this.setExaggeration(this.exaggeration);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.requestRender();
  }

  /** Stops rendering while the view is hidden (another tab); resumes when shown. */
  setActive(active: boolean): void {
    this.active = active;
    this.requestRender();
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  /** km → scene units, exaggeration included. */
  get scale(): number {
    return this.exaggeration / MOON_RADIUS_KM;
  }

  setExaggeration(x: number): void {
    this.exaggeration = x;
    const m = this.mesh.material;
    m.displacementScale = this.scale;
    m.displacementBias = 0;
    // bumpScale in the same unit as displacement (shaded slopes = displayed slopes); floor at 1×
    // to keep shading of the real slopes at exaggeration 0.
    m.bumpScale = Math.max(x, 1) / MOON_RADIUS_KM;
    this.tiles.setScale(this.scale, m.bumpScale);
    for (const o of this.overlays) o.setScale(this.scale);
    // Closest approach: ~17 km above the highest displayed point.
    this.controls.minDistance = 1 + (this.heightmap?.maxKm ?? 0) * this.scale + 0.01;
    // The grid floats just above the highest point.
    this.grid.scale.setScalar(1 + (this.heightmap?.maxKm ?? 0) * this.scale + 0.002);
    for (const mk of this.markers.children) this.placeOnSurface(mk, mk.userData.lat, mk.userData.lon);
    if (this.siteMarker.visible) this.placeOnSurface(this.siteMarker, this.siteMarker.userData.lat, this.siteMarker.userData.lon);
    if (this.ring) this.placeRing(this.ring);
    if (this.landings) this.placeLandings(this.landings);
    this.requestRender();
  }

  /** Radius of the displayed surface (scene units) at lat/lon. */
  surfaceRadius(lat: number, lon: number): number {
    return 1 + (this.heightmap ? this.heightmap.sampleKm(lat, lon) * this.scale : 0);
  }

  /**
   * Picking: camera ray → surface point.
   *  - refinePick = false: intersect the UNdisplaced sphere (r = 1), then UV → lat/lon. Fast but
   *    offset when exaggeration is strong (relief parallax).
   *  - refinePick = true: ray march on the CPU raster between spheres 1 + hmin·s and 1 + hmax·s,
   *    then bisection. Follows the displayed relief up to mesh resolution (the GPU interpolates
   *    linearly between vertices).
   * The analytic sphere is used instead of Raycaster on the ~500 k triangles: same result as
   * Raycaster on the undisplaced sphere, in O(1).
   */
  pick(clientX: number, clientY: number): PickResult | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin;
    const d = ray.ray.direction; // unit

    const s = this.scale;
    const t = !this.heightmap || !this.refinePick || s === 0 ? intersectSphere(o, d, 1)?.[0] : this.march(o, d, s, this.heightmap);
    if (t == null) return null;

    const p = o.clone().addScaledVector(d, t);
    const { u, v } = pointToUv(p.x, p.y, p.z);
    const { lat, lon } = uvToLatLon(u, v);
    return { lat, lon, altM: this.heightmap ? this.heightmap.sampleKm(lat, lon) * 1000 : null };
  }

  private march(o: THREE.Vector3, d: THREE.Vector3, s: number, hm: Heightmap): number | null {
    const outer = intersectSphere(o, d, 1 + hm.maxKm * s);
    if (!outer) return null;
    const inner = intersectSphere(o, d, 1 + hm.minKm * s);
    const t0 = Math.max(0, outer[0]);
    const t1 = inner ? inner[0] : outer[1];
    const p = new THREE.Vector3();
    // f(t) > 0 above the surface, < 0 below.
    const f = (t: number) => {
      p.copy(o).addScaledVector(d, t);
      const { u, v } = pointToUv(p.x, p.y, p.z);
      const { lat, lon } = uvToLatLon(u, v);
      return p.length() - (1 + hm.sampleKm(lat, lon) * s);
    };
    const N = 160;
    let a = t0;
    let fa = f(a);
    for (let i = 1; i <= N; i++) {
      const b = t0 + ((t1 - t0) * i) / N;
      const fb = f(b);
      if (fa > 0 && fb <= 0) {
        // Bisection: precision ~ (t1 − t0) / N / 2^12.
        let lo = a;
        let hi = b;
        for (let k = 0; k < 12; k++) {
          const m = (lo + hi) / 2;
          if (f(m) > 0) lo = m;
          else hi = m;
        }
        return (lo + hi) / 2;
      }
      a = b;
      fa = fb;
    }
    return inner ? inner[0] : null;
  }

  setGridVisible(v: boolean): void {
    this.grid.visible = v;
    this.requestRender();
  }

  addMarker(lat: number, lon: number): void {
    const mk = new THREE.Mesh(new THREE.SphereGeometry(0.004, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffb347 }));
    mk.userData = { lat, lon };
    this.placeOnSurface(mk, lat, lon);
    this.markers.add(mk);
    this.requestRender();
  }

  clearMarkers(): void {
    for (const mk of [...this.markers.children] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>[]) {
      mk.geometry.dispose();
      mk.material.dispose();
      this.markers.remove(mk);
    }
    this.requestRender();
  }

  /**
   * Past landing sites as round points of constant screen size (white = crewed, green = robotic),
   * hidden behind the Moon by the depth test. Replaces any previous set.
   */
  setLandingSites(sites: readonly { lat: number; lon: number; crewed: boolean }[]): void {
    if (this.landings) {
      this.scene.remove(this.landings);
      this.landings.geometry.dispose();
      this.landings.material.map?.dispose();
      this.landings.material.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(sites.length * 3), 3));
    const color = new THREE.Color();
    geo.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(sites.flatMap((s) => color.set(s.crewed ? 0xffffff : 0x39d98a).toArray())), 3),
    );
    geo.userData = { sites: sites.map(({ lat, lon }) => ({ lat, lon })) };
    const dot = makeDotTexture();
    this.textures.push(dot);
    this.landings = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, vertexColors: true, map: dot, alphaTest: 0.5, transparent: true }),
    );
    this.placeLandings(this.landings);
    this.scene.add(this.landings);
    this.requestRender();
  }

  /** The scenario's selected site (red marker). */
  setSite(lat: number, lon: number): void {
    this.siteMarker.userData = { lat, lon };
    this.siteMarker.visible = true;
    this.placeOnSurface(this.siteMarker, lat, lon);
    this.requestRender();
  }

  /**
   * Sun and Earth directions (Moon body frame, from the Moon's centre). The directional light is
   * pointed at the Sun, so the terminator and Earth's phase follow the same state. null = back to
   * the illustrative fixed light, bodies hidden.
   */
  setSky(sky: MoonSky | null): void {
    this.sunBody.visible = this.earthBody.visible = sky !== null;
    this.requestRender();
    if (!sky) {
      this.sky = null;
      this.sunLight.position.set(5, 1.5, 3);
      return;
    }
    this.sky = { sun: bodyToThree(sky.sun).normalize(), earth: bodyToThree(sky.earth).normalize() };
    this.sunLight.position.copy(this.sky.sun).multiplyScalar(5);
    // First sky after load: open on a view where 80 % of the visible disc is lit.
    if (!this.framedOnSun) {
      this.framedOnSun = true;
      const dist = this.camera.position.length(); // read BEFORE overwriting the position
      this.camera.position.copy(this.viewDirection(this.sky.sun, LOAD_PHASE_ANGLE)).multiplyScalar(dist);
      this.camera.lookAt(0, 0, 0);
    }
    this.earthBody.userData.rotation = bodyRotationToThree(sky.earthToBody);
  }

  /**
   * Flies the camera behind the Moon so the Sun or Earth shows just past the limb, about 24° from
   * the view centre, horizontally (fits any landscape aspect).
   */
  viewBody(which: "sun" | "earth"): void {
    if (!this.sky) return;
    const to = this.viewDirection(this.sky[which], Math.PI - THREE.MathUtils.degToRad(24));
    const from = this.camera.position.clone();
    this.flight = { from, to, d0: from.length(), d1: 4.5, t0: performance.now(), dur: 1600 };
    this.requestRender();
  }

  /** Unit vector at `angle` from `dir`, turned horizontally (about the Y axis side vector). */
  private viewDirection(dir: THREE.Vector3, angle: number): THREE.Vector3 {
    let side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (side.lengthSq() < 1e-6) side = new THREE.Vector3(1, 0, 0);
    side.normalize();
    return dir.clone().multiplyScalar(Math.cos(angle)).addScaledVector(side, Math.sin(angle)).normalize();
  }

  /**
   * On-screen direction of local north at a site, degrees clockwise from screen-up, or null when
   * the site is behind the camera. Polar fallback as lunar/skyGeometry.ts (prime-meridian limit).
   */
  northScreenAngle(lat: number, lon: number): number | null {
    const polar = Math.abs(lat) >= 90 - 1e-9;
    const la = THREE.MathUtils.degToRad(lat);
    const lo = THREE.MathUtils.degToRad(polar ? 0 : lon);
    // d/dlat of the body-frame position, mapped body → three (x, z, −y).
    const north = new THREE.Vector3(-Math.sin(la) * Math.cos(lo), Math.cos(la), Math.sin(la) * Math.sin(lo));
    const u = latLonToUnit(lat, lon);
    const a = new THREE.Vector3(u.x, u.y, u.z).multiplyScalar(this.surfaceRadius(lat, lon));
    const b = a.clone().addScaledVector(north, 0.01);
    if (a.clone().sub(this.camera.position).dot(this.camera.getWorldDirection(new THREE.Vector3())) <= 0) return null;
    a.project(this.camera);
    b.project(this.camera);
    return THREE.MathUtils.radToDeg(Math.atan2((b.x - a.x) * this.camera.aspect, b.y - a.y));
  }

  /**
   * Screen-edge pointer for the Sun or Earth: pixel position (relative to the canvas) and arrow
   * angle (degrees clockwise from screen-up). `onScreen` = inside the view (it may still be hidden
   * behind the Moon). null before setSky().
   */
  edgePointer(which: "sun" | "earth", marginPx = 36): { x: number; y: number; angle: number; onScreen: boolean } | null {
    if (!this.sky) return null;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const p = this.camera.position.clone().addScaledVector(this.sky[which], SKY_DIST);
    const behind = p.clone().sub(this.camera.position).dot(this.camera.getWorldDirection(new THREE.Vector3())) < 0;
    p.project(this.camera);
    let nx = p.x;
    let ny = p.y;
    if (behind) {
      // Projection mirrors points behind the camera: flip back, and push to the edge.
      nx = -nx;
      ny = -ny;
    }
    const onScreen = !behind && Math.abs(nx) <= 1 && Math.abs(ny) <= 1;
    const angle = THREE.MathUtils.radToDeg(Math.atan2(nx * w, ny * h));
    if (!onScreen) {
      // Slide along the centre → target ray until it touches the margin box.
      const mx = 1 - (2 * marginPx) / w;
      const my = 1 - (2 * marginPx) / h;
      const k = 1 / Math.max(Math.abs(nx) / mx, Math.abs(ny) / my, 1e-9);
      nx *= k;
      ny *= k;
    }
    return { x: ((nx + 1) / 2) * w, y: ((1 - ny) / 2) * h, angle, onScreen };
  }

  /**
   * Ground distance per screen pixel (km) at the view centre, on the reference sphere. The camera
   * always looks at the Moon's centre, so the centre ray meets the surface at |camera| − 1 radii.
   */
  kmPerPixelAtCentre(): number {
    const d = Math.max(1e-6, this.camera.position.length() - 1);
    const h = this.renderer.domElement.clientHeight || 1;
    return ((2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h) * MOON_RADIUS_KM;
  }

  /**
   * Rows [row0, row0 + rows) of the heightmap array were overwritten (streamed band): upload only
   * that band to the GPU texture (no full 66 MB re-upload), widen the height range and refresh
   * everything placed on the surface.
   */
  applyHeightBand(row0: number, rows: number): void {
    const hm = this.heightmap;
    if (!hm || !this.heightTex) return;
    const w = hm.width;
    const band = new THREE.DataTexture(hm.data.subarray(row0 * w, (row0 + rows) * w), w, rows, THREE.RedFormat, THREE.FloatType);
    this.renderer.copyTextureToTexture(band, this.heightTex, null, new THREE.Vector2(0, row0));
    band.dispose();
    hm.extendRange(row0, rows);
    this.setExaggeration(this.exaggeration); // grid, markers, ring, closest approach
    const south = (row0 / hm.height) * 180 - 90;
    this.tiles.refreshHeights(south, south + (rows / hm.height) * 180);
    this.requestRender();
  }

  /** Streaming imagery on/off (the base mesh always stays as the offline fallback). */
  setTilesEnabled(on: boolean): void {
    this.tiles.setEnabled(on);
    this.requestRender();
  }

  /** Tile download status: "loading", "ok", "offline" (3 failures in a row) or "off". */
  onTileStatus(cb: (s: TileStatus) => void): void {
    this.tiles.onStatus = cb;
    cb(this.tiles.status);
  }

  /** Called whenever the camera moves (orbit, damping, fly-to). Returns an unsubscribe function. */
  onCameraChange(cb: () => void): () => void {
    this.controls.addEventListener("change", cb);
    return () => this.controls.removeEventListener("change", cb);
  }

  /** Circle of radius `radiusKm` around a feature (visual cue for search). */
  showRing(lat: number, lon: number, radiusKm: number): void {
    if (this.ring) {
      this.ring.geometry.dispose();
      this.ring.material.dispose();
      this.scene.remove(this.ring);
    }
    const n = 128;
    const ang = Math.max(radiusKm, 2) / MOON_RADIUS_KM; // angular radius (rad)
    const pts = Array.from({ length: n + 1 }, () => new THREE.Vector3());
    const ring = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.9 }),
    );
    ring.userData = { lat, lon, ang, n };
    this.ring = ring;
    this.placeRing(ring);
    this.scene.add(ring);
    this.requestRender();
  }

  /**
   * Screen scale (km per CSS pixel) at a surface point, from its distance to the camera (same
   * pinhole formula as kmPerPixelAtCentre, which it equals at the view centre). Ignores the
   * foreshortening of oblique views: an estimate for sizing overlays, not a measurement.
   */
  kmPerPixelAt(lat: number, lon: number): number {
    const u = latLonToUnit(lat, lon);
    const r = this.surfaceRadius(lat, lon);
    const d = Math.max(1e-6, this.camera.position.distanceTo(new THREE.Vector3(u.x * r, u.y * r, u.z * r)));
    const h = this.renderer.domElement.clientHeight || 1;
    return ((2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h) * MOON_RADIUS_KM;
  }

  /** Height raster texture used for displacement (km; equirectangular, row 0 = south); null without relief. */
  get heightTexture(): THREE.Texture | null {
    return this.heightTex;
  }

  /** Adds a draped layer; returns a function removing and disposing it (also done by dispose()). */
  addSurfaceOverlay(o: SurfaceOverlay): () => void {
    this.overlays.add(o);
    o.setScale(this.scale);
    o.onChange = this.requestRender;
    this.scene.add(o.object);
    this.requestRender();
    return () => {
      if (!this.overlays.delete(o)) return;
      this.scene.remove(o.object);
      o.dispose();
      this.requestRender();
    };
  }

  /** Turns the camera toward lat/lon (spherical interpolation; distance kept or reduced). */
  flyTo(lat: number, lon: number, radiusKm = 50): void {
    const u = latLonToUnit(lat, lon);
    const to = new THREE.Vector3(u.x, u.y, u.z).normalize();
    const from = this.camera.position.clone();
    // Target distance: the feature fills about a third of the field of view.
    const want = THREE.MathUtils.clamp(1 + (radiusKm / MOON_RADIUS_KM) * 6, 1.25, 4);
    this.flight = { from, to, d0: from.length(), d1: want, t0: performance.now(), dur: 1400 };
    this.requestRender();
  }

  dispose(): void {
    this.active = false;
    cancelAnimationFrame(this.frameId);
    this.controls.removeEventListener("change", this.requestRender);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.clearMarkers();
    this.tiles.dispose();
    for (const o of this.overlays) {
      this.scene.remove(o.object);
      o.dispose();
    }
    this.overlays.clear();
    this.scene.traverse((obj) => {
      const o = obj as THREE.Mesh;
      o.geometry?.dispose();
      const mat = o.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat?.dispose();
    });
    for (const t of this.textures) t.dispose();
    this.renderer.dispose();
    // Release the WebGL context now (each tab switch creates a new one; browsers cap live contexts).
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private frame(now: number): void {
    this.frameId = 0;
    if (!this.active) return;
    const before = this.camera.position.clone();
    if (this.flight) {
      const { from, to, d0, d1, t0, dur } = this.flight;
      const k = Math.min(1, (now - t0) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // easeInOutQuad
      const q = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to);
      const dir = from.clone().normalize().applyQuaternion(new THREE.Quaternion().slerp(q, e));
      this.camera.position.copy(dir.multiplyScalar(d0 + (d1 - d0) * e));
      this.camera.lookAt(0, 0, 0);
      if (k >= 1) this.flight = null;
    }
    if (this.ring) this.ring.material.opacity = 0.55 + 0.4 * Math.sin(now / 250);
    this.controls.update();
    this.tiles.update(this.camera, this.renderer.domElement.clientHeight);
    this.sizeMarkers();
    if (this.sky) {
      // Re-centre on the camera every frame: directions, not positions, are what is physical.
      const cam = this.camera.position;
      this.sunBody.position.copy(cam).addScaledVector(this.sky.sun, SKY_DIST);
      this.earthBody.matrix
        .copy(this.earthBody.userData.rotation as THREE.Matrix4)
        .setPosition(cam.clone().addScaledVector(this.sky.earth, SKY_DIST));
      this.earthBody.matrixWorldNeedsUpdate = true; // matrixAutoUpdate is off: refresh matrixWorld
    }
    this.renderer.render(this.scene, this.camera);
    if (this.flight || this.ring || this.dragging || this.camera.position.distanceToSquared(before) > CAMERA_MOVE_EPS_SQ) this.requestRender();
  }

  /**
   * Keeps the site and click markers at a constant size ON SCREEN (radius in CSS pixels) whatever
   * the zoom: a fixed scene size would cover tens of km close up and hide the terrain / overlays.
   */
  private sizeMarkers(): void {
    const h = this.renderer.domElement.clientHeight || 1;
    const k = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h; // scene units per px per unit distance
    const fit = (obj: THREE.Mesh<THREE.SphereGeometry>, px: number) => {
      const r0 = obj.geometry.parameters.radius;
      obj.scale.setScalar((px * k * this.camera.position.distanceTo(obj.position)) / r0);
    };
    if (this.siteMarker.visible) fit(this.siteMarker, SITE_MARKER_PX);
    for (const mk of this.markers.children) fit(mk as THREE.Mesh<THREE.SphereGeometry>, CLICK_MARKER_PX);
  }

  private placeOnSurface(obj: THREE.Object3D, lat: number, lon: number): void {
    const u = latLonToUnit(lat, lon);
    // Just above the imagery tiles (lifted 0.0004): markers are small on screen now, so a large
    // offset would show as parallax away from the clicked point when viewed obliquely.
    obj.position.set(u.x, u.y, u.z).multiplyScalar(this.surfaceRadius(lat, lon) + 0.0008);
  }

  private placeLandings(pts: THREE.Points): void {
    const pos = pts.geometry.getAttribute("position") as THREE.BufferAttribute;
    (pts.geometry.userData.sites as { lat: number; lon: number }[]).forEach(({ lat, lon }, i) => {
      const u = latLonToUnit(lat, lon);
      const r = this.surfaceRadius(lat, lon) + 0.002;
      pos.setXYZ(i, u.x * r, u.y * r, u.z * r);
    });
    pos.needsUpdate = true;
    pts.geometry.computeBoundingSphere();
  }

  private placeRing(ring: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>): void {
    const { lat, lon, ang, n } = ring.userData as { lat: number; lon: number; ang: number; n: number };
    const c = latLonToUnit(lat, lon);
    const center = new THREE.Vector3(c.x, c.y, c.z);
    // Orthonormal basis of the tangent plane; auxiliary axis chosen to stay well conditioned at the poles.
    const aux = Math.abs(center.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const e1 = new THREE.Vector3().crossVectors(center, aux).normalize();
    const e2 = new THREE.Vector3().crossVectors(center, e1);
    const pos = ring.geometry.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * 2 * Math.PI;
      v.copy(center)
        .multiplyScalar(Math.cos(ang))
        .addScaledVector(e1, Math.sin(ang) * Math.cos(a))
        .addScaledVector(e2, Math.sin(ang) * Math.sin(a));
      const { u: uu, v: vv } = pointToUv(v.x, v.y, v.z);
      const ll = uvToLatLon(uu, vv);
      v.multiplyScalar(this.surfaceRadius(ll.lat, ll.lon) + 0.003);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    ring.geometry.computeBoundingSphere();
  }
}

/** Ray/sphere intersections, sphere centred at the origin, d unit. Returns [tEnter, tExit] or null. */
function intersectSphere(o: THREE.Vector3, d: THREE.Vector3, r: number): [number, number] | null {
  const b = o.dot(d);
  const c = o.lengthSq() - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const tExit = -b + sq;
  if (tExit < 0) return null;
  return [-b - sq, tExit];
}

/** Unlit solar disc plus an additive glow sprite (the glow is decoration, not the true corona). */
export function makeSun(radius: number, textures: THREE.Texture[]): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16), new THREE.MeshBasicMaterial({ color: 0xfff6d5 })));
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,240,190,0.9)");
  grad.addColorStop(0.2, "rgba(255,210,120,0.35)");
  grad.addColorStop(1, "rgba(255,200,100,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const map = new THREE.CanvasTexture(c);
  textures.push(map); // freed by Globe.dispose()
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  glow.scale.setScalar(radius * 14);
  g.add(glow);
  return g;
}

/** Lat/lon grid every 15°, equator and prime meridian highlighted. Radius 1 (scaled later). */
function makeGrid(): THREE.Group {
  const group = new THREE.Group();
  const minor = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18 });
  const major = new THREE.LineBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.6 });
  const toV = (lat: number, lon: number) => {
    const u = latLonToUnit(lat, lon);
    return new THREE.Vector3(u.x, u.y, u.z);
  };
  for (let lat = -75; lat <= 75; lat += 15) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 2) pts.push(toV(lat, lon));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lat === 0 ? major : minor));
  }
  for (let lon = -180; lon < 180; lon += 15) {
    const pts = [];
    for (let lat = -90; lat <= 90; lat += 2) pts.push(toV(lat, lon));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lon === 0 ? major : minor));
  }
  return group;
}

/** Round point sprite: filled disc with a dark rim, so the points read on bright and dark ground. */
function makeDotTexture(): THREE.CanvasTexture {
  const c = Object.assign(document.createElement("canvas"), { width: 32, height: 32 });
  const g = c.getContext("2d");
  if (g) {
    g.beginPath();
    g.arc(16, 16, 14, 0, 2 * Math.PI);
    g.fillStyle = "#ffffff";
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = "#202020";
    g.stroke();
  }
  return new THREE.CanvasTexture(c);
}
