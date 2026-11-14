// Schematic lit-disc icon from the illuminated fraction (northern-hemisphere view: waxing = lit on the right).
// Not a rendering of the real lunar surface, libration or position angle of the bright limb.

export function moonPhasePath(k: number, waxing: boolean, r: number, cx: number, cy: number): string {
  const kk = Math.min(1, Math.max(0, k));
  const rx = r * Math.abs(1 - 2 * kk); // terminator ellipse half-width = r·|cos i|
  const limbSweep = waxing ? 1 : 0;
  const termSweep = (kk < 0.5) === waxing ? 0 : 1;
  return `M ${cx} ${cy - r} A ${r} ${r} 0 0 ${limbSweep} ${cx} ${cy + r} A ${rx} ${r} 0 0 ${termSweep} ${cx} ${cy - r} Z`;
}

export function MoonPhaseIcon({ fraction, waxing, size = 64 }: { fraction: number; waxing: boolean; size?: number }) {
  const r = size / 2 - 2;
  const c = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${Math.round(fraction * 100)}% illuminated`}>
      <circle cx={c} cy={c} r={r} fill="#1d222c" stroke="#3a4252" />
      <path d={moonPhasePath(fraction, waxing, r, c, c)} fill="#e9e4d4" />
    </svg>
  );
}
