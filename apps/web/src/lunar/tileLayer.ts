// Streaming high-resolution imagery over the Moon globe (QuickMap-style level of detail).
//
// The global mesh (4k colour + LOLA displacement) stays underneath as the offline fallback; this
// layer draws NASA Moon Trek WAC-mosaic tiles on top, only where they are sharper than the base
// texture and only for the visible part of the sphere:
//   - quadtree from the two level-0 tiles; a tile is refined while one of its texels covers more
//     than ~1.3 screen pixels (screen-space error at its nearest point), down to MAX_LEVEL;
//   - a parent stays drawn until all its visible children are loaded (no holes, no overlap);
//   - tile meshes follow the same LOLA raster as the base mesh (CPU displacement) and are lit
//     with the same LOLA bump map (shared GPU texture, per-tile UV transform), so the light does
//     not jump when tiles replace the base; drawn with a polygon offset to win the depth test;
//   - at most MAX_INFLIGHT downloads, coarse levels first; LRU cache of MAX_CACHED tiles.
// Imagery only: picking, altitude and the scenario maths still use the LOLA raster.

import * as THREE from "three";

import { latLonToUnit } from "./geo";
import type { Heightmap } from "./heightmap";
import {
  childTiles,
  firstUsefulLevel,
  MAX_LEVEL,
  rootTiles,
  TILE_PX,
  type TileId,
  tileBounds,
  tileKey,
  tileSpanDeg,
  tileToGlobalUv,
  tileUrl,
} from "./tileScheme";

const SEGMENTS = 32; // per tile edge: ≤ base-mesh vertex spacing from the first useful level on
const MAX_INFLIGHT = 6;
const MAX_CACHED = 256; // ≈ 70 MB of GPU textures with mipmaps
const SSE_PX = 1.3;
const LIFT = 0.0004; // scene units (≈ 0.7 km): keeps tiles above the coarser base mesh
const DEG = Math.PI / 180;

export type TileStatus = "off" | "loading" | "ok" | "offline";

/** Stencil value written by drawn tiles; the base mesh skips those pixels (Globe). */
export const TILE_STENCIL = 1;

interface Entry {
  id: TileId;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null;
  state: "queued" | "loading" | "ready" | "failed";
  lastUsed: number;
}

export class TileLayer {
  readonly group = new THREE.Group();
  private readonly cache = new Map<string, Entry>();
  private readonly queue: Entry[] = [];
  private readonly loader = new THREE.TextureLoader();
  private readonly minLevel: number;
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private inflight = 0;
  private failures = 0;
  private frameNo = 0;
  private disposed = false;
  private enabled = true;
  private scale = 0;
  private bumpScale = 0;
  status: TileStatus = "loading";
  onStatus?: (s: TileStatus) => void;

  constructor(
    private readonly heightmap: Heightmap | null,
    /** the base mesh's LOLA DataTexture, reused as bump map (null: no relief shading) */
    private readonly heightTex: THREE.Texture | null,
    private readonly maxAnisotropy: number,
    baseTexturePx: number,
  ) {
    this.loader.setCrossOrigin("anonymous");
    this.minLevel = Math.max(1, firstUsefulLevel(baseTexturePx));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
    this.setStatus(on ? (this.failures >= 3 ? "offline" : "ok") : "off");
  }

  /**
   * km → scene units (exaggeration included) and the base mesh's bumpScale; rebuilds the displaced
   * geometry of cached tiles.
   */
  setScale(scale: number, bumpScale: number): void {
    this.bumpScale = bumpScale;
    for (const e of this.cache.values()) if (e.mesh) e.mesh.material.bumpScale = bumpScale;
    if (scale === this.scale) return;
    this.scale = scale;
    for (const e of this.cache.values()) if (e.mesh) this.fillPositions(e.mesh.geometry, e.id);
  }

  /** Call once per frame. */
  update(camera: THREE.PerspectiveCamera, viewportHeightPx: number): void {
    if (!this.enabled || this.disposed) return;
    this.frameNo++;
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const pxPerRadAtUnitDist = viewportHeightPx / (2 * Math.tan((camera.fov * DEG) / 2));

    const draw = new Set<string>();
    for (const root of rootTiles()) {
      const list = this.select(root, camera.position, pxPerRadAtUnitDist);
      for (const e of list ?? []) draw.add(tileKey(e.id));
    }
    for (const [k, e] of this.cache) if (e.mesh) e.mesh.visible = draw.has(k);
    this.pump();
    this.evict();
  }

  /**
   * Tiles to draw for this subtree, [] if nothing is needed (invisible, or the base texture is
   * enough), or null if it cannot be drawn yet (not loaded).
   */
  private select(id: TileId, cam: THREE.Vector3, pxPerRad: number): Entry[] | null {
    const b = tileBounds(id);
    const latC = (b.south + b.north) / 2;
    const lonC = (b.west + b.east) / 2;
    const u = latLonToUnit(latC, lonC);
    const centre = new THREE.Vector3(u.x, u.y, u.z);
    const half = Math.min(Math.PI, tileSpanDeg(id.z) * DEG * Math.SQRT1_2); // angular radius (conservative)
    const top = 1 + (this.heightmap?.maxKm ?? 0) * this.scale;
    const chord = 2 * Math.sin(half / 2) * top; // centre → farthest corner

    // Horizon: the closest point of the tile must be above the camera's horizon.
    const camDist = cam.length();
    const angToCam = centre.angleTo(cam);
    if (Math.cos(Math.max(0, angToCam - half)) * camDist < 1 - 0.02 && id.z > 0) return [];
    // Frustum.
    if (!this.frustum.intersectsSphere(new THREE.Sphere(centre, chord + (top - 1) + 0.002))) return [];

    // Screen-space size of one texel at the tile's nearest point.
    const nearest = Math.max(1e-4, cam.distanceTo(centre) - chord);
    const texelRad = (tileSpanDeg(id.z) * DEG) / TILE_PX;
    const texelPx = (texelRad * pxPerRad) / nearest;
    const refine = texelPx > SSE_PX && id.z < MAX_LEVEL;

    if (refine) {
      const lists = childTiles(id).map((c) => this.select(c, cam, pxPerRad));
      if (lists.every((l) => l !== null)) return lists.flat() as Entry[];
    }
    // Coarse levels: the base texture is as sharp (or the children are not ready yet).
    if (id.z < this.minLevel) return [];
    const e = this.touch(id);
    return e.state === "ready" ? [e] : null;
  }

  private touch(id: TileId): Entry {
    const k = tileKey(id);
    let e = this.cache.get(k);
    if (!e) {
      e = { id, mesh: null, state: "queued", lastUsed: this.frameNo };
      this.cache.set(k, e);
      this.queue.push(e);
    }
    e.lastUsed = this.frameNo;
    return e;
  }

  private pump(): void {
    // Coarse first, then most recently needed.
    this.queue.sort((a, b) => a.id.z - b.id.z || b.lastUsed - a.lastUsed);
    while (this.inflight < MAX_INFLIGHT && this.queue.length) {
      const e = this.queue.shift()!;
      if (e.state !== "queued" || this.frameNo - e.lastUsed > 2) {
        if (e.state === "queued") this.cache.delete(tileKey(e.id)); // no longer needed
        continue;
      }
      e.state = "loading";
      this.inflight++;
      this.setStatus("loading");
      this.loader.load(
        tileUrl(e.id),
        (tex) => {
          this.inflight--;
          if (this.disposed || this.cache.get(tileKey(e.id)) !== e) return tex.dispose();
          this.failures = 0;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = this.maxAnisotropy;
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          e.mesh = this.makeMesh(e.id, tex);
          this.group.add(e.mesh);
          e.state = "ready";
          if (this.inflight === 0) this.setStatus("ok");
        },
        undefined,
        () => {
          this.inflight--;
          e.state = "failed";
          if (++this.failures >= 3) this.setStatus("offline");
        },
      );
    }
  }

  private evict(): void {
    if (this.cache.size <= MAX_CACHED) return;
    const old = [...this.cache.values()]
      .filter((e) => e.state === "ready" || e.state === "failed")
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of old.slice(0, this.cache.size - MAX_CACHED)) {
      if (e.lastUsed === this.frameNo) break; // never evict what is on screen
      this.release(e);
      this.cache.delete(tileKey(e.id));
    }
  }

  private makeMesh(id: TileId, tex: THREE.Texture) {
    const n = SEGMENTS + 1;
    const g = new THREE.BufferGeometry();
    const uv = new Float32Array(n * n * 2);
    const idx: number[] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        uv[2 * k] = i / SEGMENTS;
        uv[2 * k + 1] = j / SEGMENTS; // j = 0 at the south edge; image top (north) is v = 1
        if (i < SEGMENTS && j < SEGMENTS) idx.push(k, k + 1, k + n, k + 1, k + n + 1, k + n);
      }
    }
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
    g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * n * 3), 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.fillPositions(g, id);
    const m = new THREE.MeshStandardMaterial({
      map: tex,
      bumpMap: this.heightTex,
      bumpScale: this.bumpScale,
      roughness: 1,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      // Mark covered pixels: the base mesh (renderOrder 1, drawn after) is masked there.
      stencilWrite: true,
      stencilRef: TILE_STENCIL,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    if (this.heightTex) {
      // Sample the GLOBAL raster at this tile's lon/lat: replace three's per-texture bump UV
      // transform by a per-material one (no texture clone, so no re-upload of the raster).
      const t = tileToGlobalUv(id);
      const uv = new THREE.Matrix3().setUvTransform(t.offsetU, t.offsetV, t.scaleU, t.scaleV, 0, 0, 0);
      m.onBeforeCompile = (shader) => {
        shader.uniforms.tileBumpTransform = { value: uv };
        shader.vertexShader =
          "uniform mat3 tileBumpTransform;\n" +
          shader.vertexShader.replace("bumpMapTransform * vec3( BUMPMAP_UV, 1 )", "tileBumpTransform * vec3( BUMPMAP_UV, 1 )");
      };
      m.customProgramCacheKey = () => "moon-tile-bump"; // one shader program for all tiles
    }
    const mesh = new THREE.Mesh(g, m);
    mesh.visible = false;
    return mesh;
  }

  /** Vertex positions on the LOLA-displaced surface; radial normals, as the base sphere (the bump map adds relief). */
  private fillPositions(g: THREE.BufferGeometry, id: TileId): void {
    const b = tileBounds(id);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal as THREE.BufferAttribute;
    const n = SEGMENTS + 1;
    for (let j = 0; j < n; j++) {
      const lat = b.south + ((b.north - b.south) * j) / SEGMENTS;
      for (let i = 0; i < n; i++) {
        const lon = b.west + ((b.east - b.west) * i) / SEGMENTS;
        const u = latLonToUnit(lat, lon);
        const r = 1 + (this.heightmap ? this.heightmap.sampleKm(lat, lon) * this.scale : 0) + LIFT;
        const k = j * n + i;
        pos.setXYZ(k, u.x * r, u.y * r, u.z * r);
        nor.setXYZ(k, u.x, u.y, u.z);
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    g.computeBoundingSphere();
  }

  private release(e: Entry): void {
    if (!e.mesh) return;
    this.group.remove(e.mesh);
    e.mesh.geometry.dispose();
    e.mesh.material.map?.dispose();
    e.mesh.material.dispose();
    e.mesh = null;
  }

  private setStatus(s: TileStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.onStatus?.(s);
  }

  dispose(): void {
    this.disposed = true;
    for (const e of this.cache.values()) this.release(e);
    this.cache.clear();
    this.queue.length = 0;
  }
}
