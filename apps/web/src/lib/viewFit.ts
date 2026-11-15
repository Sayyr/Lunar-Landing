export const easeInOutQuad = (k: number): number => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

export function centreShift(left: number, right: number): number {
  return (left - right) / 2;
}

export function refitDistance(d0: number, widthRatio: number): number {
  return Math.sqrt(1 + (d0 * d0 - 1) / (widthRatio * widthRatio));
}
