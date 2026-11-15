export interface LonLatBox {
  west: number;
  east: number;
  south: number;
  north: number;
}

export interface LuminanceGrid {
  data: Float32Array;
  width: number;
  height: number;
}

const toLinear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function luminanceGrid(rgba: ArrayLike<number>, width: number, height: number): LuminanceGrid {
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = 0.2126 * toLinear(rgba[i * 4]) + 0.7152 * toLinear(rgba[i * 4 + 1]) + 0.0722 * toLinear(rgba[i * 4 + 2]);
  }
  return { data, width, height };
}

export function meanLuminance(grid: LuminanceGrid): number {
  let s = 0;
  for (const v of grid.data) s += v;
  return s / grid.data.length;
}

export function meanOverBox(grid: LuminanceGrid, box: LonLatBox): number {
  const { data, width, height } = grid;
  const x = (lon: number) => ((lon + 180) / 360) * width;
  const y = (lat: number) => ((90 - lat) / 180) * height;
  const cx = (x(box.west) + x(box.east)) / 2;
  const cy = (y(box.north) + y(box.south)) / 2;
  const hx = Math.max(1, (x(box.east) - x(box.west)) / 2);
  const hy = Math.max(1, (y(box.south) - y(box.north)) / 2);
  const x0 = Math.max(0, Math.floor(cx - hx));
  const x1 = Math.min(width, Math.ceil(cx + hx));
  const y0 = Math.max(0, Math.floor(cy - hy));
  const y1 = Math.min(height, Math.ceil(cy + hy));
  let s = 0;
  let n = 0;
  for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) {
    s += data[j * width + i];
    n++;
  }
  return n ? s / n : 0;
}

export function tileGain(referenceMean: number, tileMean: number): number {
  if (!(referenceMean > 0) || !(tileMean > 0)) return 1;
  return Math.min(4, Math.max(0.5, referenceMean / tileMean));
}

export function sampleImage(image: CanvasImageSource, width: number, height: number): LuminanceGrid | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);
    return luminanceGrid(ctx.getImageData(0, 0, width, height).data, width, height);
  } catch {
    return null;
  }
}
