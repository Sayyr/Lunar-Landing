// globe.js — scène three.js : Lune texturée et déplacée, grille, marqueurs, pointage.
//
// Unités de la scène : 1 unité = rayon de référence (1737,4 km).
// Le raster d'altitude est en km → échelle de déplacement = exagération / 1737,4.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MOON_RADIUS_KM, latLonToUnit, pointToUv, uvToLatLon } from './geo.js';

export class Globe {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {HTMLImageElement} opts.colorImage
   * @param {import('./heightmap.js').Heightmap} opts.heightmap
   * @param {number} opts.segments  segments en longitude (la moitié en latitude)
   */
  constructor(container, { colorImage, heightmap, segments }) {
    this.container = container;
    this.heightmap = heightmap;
    this.exaggeration = 1;
    this.refinePick = true;

    // --- Rendu -----------------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(
      40, container.clientWidth / container.clientHeight, 0.001, 100);
    camera.position.set(3.2, 0.6, 0); // face à lon 0°, lat ~10° N
    this.camera = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 1.08;
    controls.maxDistance = 8;
    controls.rotateSpeed = 0.5;
    this.controls = controls;
    // Rotation plus lente quand on est près de la surface.
    controls.addEventListener('change', () => {
      const alt = camera.position.length() - 1;
      controls.rotateSpeed = Math.min(0.5, 0.15 + alt * 0.2);
    });

    // --- Éclairage : « Soleil » directionnel ILLUSTRATIF (pas d'éphéméride) --------
    const sun = new THREE.DirectionalLight(0xffffff, 3.0);
    sun.position.set(5, 1.5, 3);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0xffffff, 0.06));
    this.sun = sun;

    // --- Textures ------------------------------------------------------------------
    const colorTex = new THREE.Texture(colorImage);
    colorTex.colorSpace = THREE.SRGBColorSpace;
    colorTex.wrapS = THREE.RepeatWrapping;
    colorTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    colorTex.needsUpdate = true;

    // DataTexture flottante sur le Float32Array du raster (aucune copie CPU) :
    // les lignes ont été inversées en place au chargement (ligne 0 = sud = v 0).
    const { data, width, height } = heightmap;
    const heightTex = new THREE.DataTexture(
      data, width, height, THREE.RedFormat, THREE.FloatType);
    heightTex.wrapS = THREE.RepeatWrapping; // raccord continu à ±180°
    heightTex.wrapT = THREE.ClampToEdgeWrapping;
    // Le filtrage linéaire des textures float32 n'est pas garanti (mobiles) : repli Nearest.
    const linearOk = renderer.extensions.has('OES_texture_float_linear');
    heightTex.magFilter = linearOk ? THREE.LinearFilter : THREE.NearestFilter;
    heightTex.minFilter = linearOk ? THREE.LinearFilter : THREE.NearestFilter;
    heightTex.generateMipmaps = false;
    heightTex.flipY = false;
    heightTex.needsUpdate = true;
    this.floatLinear = linearOk;

    // --- Sphère ------------------------------------------------------------------------
    const geometry = new THREE.SphereGeometry(1, segments, segments / 2);
    const material = new THREE.MeshStandardMaterial({
      map: colorTex,
      displacementMap: heightTex,
      // Le même raster sert de bumpMap : l'ombrage suit le relief sans recalcul des normales
      // ni texture supplémentaire en mémoire.
      bumpMap: heightTex,
      roughness: 1,
      metalness: 0,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    scene.add(this.mesh);

    // --- Grille lat/lon, marqueurs, anneau de sélection -----------------------------
    this.grid = makeGrid();
    this.grid.visible = false;
    scene.add(this.grid);

    this.markers = new THREE.Group();
    scene.add(this.markers);

    this.ring = null;
    this.flight = null;

    this.setExaggeration(this.exaggeration);

    window.addEventListener('resize', () => this.resize());
    renderer.setAnimationLoop((t) => this.#frame(t));
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** km → unités de scène, exagération comprise. */
  get scale() {
    return this.exaggeration / MOON_RADIUS_KM;
  }

  setExaggeration(x) {
    this.exaggeration = x;
    const m = this.mesh.material;
    m.displacementScale = this.scale;
    m.displacementBias = 0;
    // bumpScale dans la même unité que le déplacement (pentes ombrées = pentes affichées) ;
    // plancher à 1× pour garder l'ombrage des pentes réelles à exagération 0.
    m.bumpScale = Math.max(x, 1) / MOON_RADIUS_KM;
    // La grille flotte juste au-dessus du point le plus haut.
    this.grid.scale.setScalar(1 + this.heightmap.maxKm * this.scale + 0.002);
    for (const mk of this.markers.children) this.#placeOnSurface(mk, mk.userData.lat, mk.userData.lon);
    if (this.ring) this.#placeRing(this.ring);
  }

  /** Rayon de la surface affichée (unités de scène) au point lat/lon. */
  surfaceRadius(lat, lon) {
    return 1 + this.heightmap.sampleKm(lat, lon) * this.scale;
  }

  /**
   * Pointage : rayon caméra → point de surface.
   *  - refinePick = false : intersection avec la sphère NON déplacée (r = 1), puis UV →
   *    lat/lon. Rapide mais décalé quand l'exagération est forte (parallaxe du relief).
   *  - refinePick = true  : marche de rayon sur le raster CPU entre les sphères
   *    1 + hmin·s et 1 + hmax·s, puis dichotomie. Suit le relief affiché, à la résolution
   *    du maillage près (le GPU interpole linéairement entre sommets).
   * Note : on intersecte une sphère analytique plutôt que les ~500 k triangles du mesh :
   * même résultat que Raycaster sur la sphère non déplacée, en O(1).
   */
  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin;
    const d = ray.ray.direction; // unitaire

    let t;
    const s = this.scale;
    if (!this.refinePick || s === 0) {
      t = intersectSphere(o, d, 1)?.[0];
    } else {
      t = this.#march(o, d, s);
    }
    if (t == null) return null;

    const p = o.clone().addScaledVector(d, t);
    const { u, v } = pointToUv(p.x, p.y, p.z);
    const { lat, lon } = uvToLatLon(u, v);
    const altKm = this.heightmap.sampleKm(lat, lon);
    return { lat, lon, altM: altKm * 1000, u, v, point: p };
  }

  #march(o, d, s) {
    const hm = this.heightmap;
    const outer = intersectSphere(o, d, 1 + hm.maxKm * s);
    if (!outer) return null;
    const inner = intersectSphere(o, d, 1 + hm.minKm * s);
    const t0 = Math.max(0, outer[0]);
    const t1 = inner ? inner[0] : outer[1];
    const p = new THREE.Vector3();
    // f(t) > 0 au-dessus de la surface, < 0 en dessous.
    const f = (t) => {
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
        // Dichotomie : précision ~ (t1 - t0) / N / 2^12.
        let lo = a;
        let hi = b;
        for (let k = 0; k < 12; k++) {
          const m = (lo + hi) / 2;
          if (f(m) > 0) lo = m; else hi = m;
        }
        return (lo + hi) / 2;
      }
      a = b;
      fa = fb;
    }
    return inner ? inner[0] : null;
  }

  setGridVisible(v) {
    this.grid.visible = v;
  }

  addMarker(lat, lon) {
    const mk = new THREE.Mesh(
      new THREE.SphereGeometry(0.004, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffb347 }));
    mk.userData = { lat, lon };
    this.#placeOnSurface(mk, lat, lon);
    this.markers.add(mk);
    return mk;
  }

  clearMarkers() {
    for (const mk of [...this.markers.children]) {
      mk.geometry.dispose();
      mk.material.dispose();
      this.markers.remove(mk);
    }
  }

  /** Cercle de rayon `radiusKm` autour d'une formation (repère visuel de la recherche). */
  showRing(lat, lon, radiusKm) {
    if (this.ring) {
      this.ring.geometry.dispose();
      this.scene.remove(this.ring);
    }
    const n = 128;
    const pts = [];
    const ang = Math.max(radiusKm, 2) / MOON_RADIUS_KM; // rayon angulaire (rad)
    for (let i = 0; i <= n; i++) pts.push(new THREE.Vector3());
    const ring = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.9 }));
    ring.userData = { lat, lon, ang, n };
    this.ring = ring;
    this.#placeRing(ring);
    this.scene.add(ring);
  }

  /** Oriente la caméra vers lat/lon (interpolation sphérique, distance conservée ou rapprochée). */
  flyTo(lat, lon, radiusKm = 50) {
    const u = latLonToUnit(lat, lon);
    const to = new THREE.Vector3(u.x, u.y, u.z).normalize();
    const from = this.camera.position.clone();
    // Distance cible : la formation occupe environ un tiers du champ.
    const want = THREE.MathUtils.clamp(1 + (radiusKm / MOON_RADIUS_KM) * 6, 1.25, 4);
    this.flight = { from, to, d0: from.length(), d1: want, t0: performance.now(), dur: 1400 };
  }

  #frame(now) {
    if (this.flight) {
      const { from, to, d0, d1, t0, dur } = this.flight;
      const k = Math.min(1, (now - t0) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // easeInOutQuad
      const q = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to);
      const dir = from.clone().normalize().applyQuaternion(
        new THREE.Quaternion().slerp(q, e));
      this.camera.position.copy(dir.multiplyScalar(d0 + (d1 - d0) * e));
      this.camera.lookAt(0, 0, 0);
      if (k >= 1) this.flight = null;
    }
    if (this.ring) {
      this.ring.material.opacity = 0.55 + 0.4 * Math.sin(now / 250);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  #placeOnSurface(obj, lat, lon) {
    const u = latLonToUnit(lat, lon);
    obj.position.set(u.x, u.y, u.z).multiplyScalar(this.surfaceRadius(lat, lon) + 0.002);
  }

  #placeRing(ring) {
    const { lat, lon, ang, n } = ring.userData;
    const c = latLonToUnit(lat, lon);
    const center = new THREE.Vector3(c.x, c.y, c.z);
    // Base orthonormée du plan tangent ; axe auxiliaire choisi pour rester bien
    // conditionné aux pôles.
    const aux = Math.abs(center.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const e1 = new THREE.Vector3().crossVectors(center, aux).normalize();
    const e2 = new THREE.Vector3().crossVectors(center, e1);
    const pos = ring.geometry.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * 2 * Math.PI;
      v.copy(center).multiplyScalar(Math.cos(ang))
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

/** Intersections rayon/sphère centrée à l'origine ; d unitaire. Retourne [tEntrée, tSortie] ou null. */
function intersectSphere(o, d, r) {
  const b = o.dot(d);
  const c = o.lengthSq() - r * r;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const tExit = -b + sq;
  if (tExit < 0) return null;
  return [-b - sq, tExit];
}

/** Grille lat/lon tous les 15°, équateur et méridien 0° accentués. Rayon 1 (mis à l'échelle). */
function makeGrid() {
  const group = new THREE.Group();
  const minor = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18 });
  const major = new THREE.LineBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.6 });
  const toV = (lat, lon) => {
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
