// heightmap.js — accès CPU au raster d'altitude LOLA (CGI Moon Kit, ldem_*.tif).
// Module pur (sans three.js) : testable avec `node --test`.
//
// Format source (vérifié sur ldem_4.tif) : TIFF float32 non compressé, une bande,
// valeurs en km relatives au rayon 1737,4 km, ligne 0 = nord (+90°),
// colonne 0 = bord ouest à -180°, pixels « area » (centre du pixel i à -180 + (i+0,5)·360/W).
// NB : ce n'est pas un GeoTIFF au sens strict (aucune GeoKey) ; le géoréférencement
// ci-dessus vient de la documentation du CGI Moon Kit et a été contrôlé sur les extrêmes
// (point culminant ≈ 5,4° N 158,6° O, +10,5 km).

/**
 * Inverse l'ordre des lignes EN PLACE (aucune copie du raster complet).
 * Après l'appel : ligne 0 = sud, ce qu'attend une DataTexture three.js (flipY = false,
 * la ligne 0 est en v = 0, c'est-à-dire au pôle sud de la SphereGeometry).
 */
export function flipRowsInPlace(data, width, height) {
  const tmp = new Float32Array(width); // tampon d'une seule ligne
  for (let top = 0, bot = height - 1; top < bot; top++, bot--) {
    const a = top * width;
    const b = bot * width;
    tmp.set(data.subarray(a, a + width));
    data.copyWithin(a, b, b + width);
    data.set(tmp, b);
  }
}

export class Heightmap {
  /**
   * @param {Float32Array} data  raster en km, lignes déjà inversées (ligne 0 = sud)
   * @param {number} width
   * @param {number} height
   * @param {string} label       nom du produit (ex. « ldem_16 »)
   */
  constructor(data, width, height, label = '') {
    this.data = data;
    this.width = width;
    this.height = height;
    this.label = label;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < data.length; i++) {
      const h = data[i];
      if (h < min) min = h;
      if (h > max) max = h;
    }
    this.minKm = min;
    this.maxKm = max;
    /** Résolution approximative à l'équateur (km par pixel). */
    this.kmPerPixel = (2 * Math.PI * 1737.4) / width;
  }

  /**
   * Altitude en km par interpolation bilinéaire (comme le filtrage linéaire du GPU) :
   * longitude répétée (raccord à ±180°), latitude bornée aux lignes extrêmes.
   */
  sampleKm(lat, lon) {
    const { width: W, height: H, data } = this;
    const x = ((lon + 180) / 360) * W - 0.5;
    const y = ((lat + 90) / 180) * H - 0.5; // ligne 0 = sud après inversion
    const x0 = Math.floor(x);
    const fx = x - x0;
    const yc = Math.min(H - 1, Math.max(0, y));
    const y0 = Math.min(H - 2, Math.floor(yc));
    const fy = yc - y0;
    const xa = ((x0 % W) + W) % W;
    const xb = (xa + 1) % W;
    const r0 = y0 * W;
    const r1 = r0 + W;
    const top = data[r0 + xa] * (1 - fx) + data[r0 + xb] * fx;
    const bot = data[r1 + xa] * (1 - fx) + data[r1 + xb] * fx;
    return top * (1 - fy) + bot * fy;
  }

  sampleM(lat, lon) {
    return this.sampleKm(lat, lon) * 1000;
  }
}
