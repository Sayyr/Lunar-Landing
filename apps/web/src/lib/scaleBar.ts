// Map-style scale bar: picks a round length (1, 2 or 5 × 10ⁿ km) that fits in `maxPx`.

export interface Scale {
  km: number;
  px: number;
  label: string;
}

export function niceScale(kmPerPx: number, maxPx = 120): Scale | null {
  if (!(kmPerPx > 0) || !Number.isFinite(kmPerPx)) return null;
  const maxKm = kmPerPx * maxPx;
  const p = 10 ** Math.floor(Math.log10(maxKm));
  const km = [5, 2, 1].map((m) => m * p).find((v) => v <= maxKm) ?? p;
  const label = km >= 1 ? `${km.toLocaleString("en-US").replace(/,/g, " ")} km` : `${Math.round(km * 1000)} m`;
  return { km, px: km / kmPerPx, label };
}
