import type { Sample, TerrainHorizon } from "../api/types";

const W = 720;
const H = 170;
const PAD = { l: 44, r: 12, t: 12, b: 26 };
const COMPASS = ["N", "E", "S", "W", "N"];

/**
 * Terrain horizon seen from the site (elevation of the skyline versus azimuth), with the path of
 * the Sun and Earth centres over the scenario. Draws what the science service returned: nothing is
 * recomputed here.
 */
export function HorizonProfile({ terrain, samples }: { terrain: TerrainHorizon; samples: Sample[] }) {
  const h = terrain.elevation_deg;
  const n = h.length;
  if (n < 4) return null;
  const all = [...h, ...samples.flatMap((s) => [s.sun.elevation_deg, s.earth.elevation_deg])];
  const lo = Math.floor(Math.min(-1, ...all));
  const hi = Math.ceil(Math.max(1, ...all));
  const x = (az: number) => PAD.l + (az / 360) * (W - PAD.l - PAD.r);
  const y = (deg: number) => PAD.t + ((hi - deg) / (hi - lo)) * (H - PAD.t - PAD.b);
  const skyline = h.map((e, j) => `${x(j * terrain.azimuth_step_deg).toFixed(1)},${y(e).toFixed(1)}`);
  // Closed polygon: skyline, then along the bottom edge (the ground).
  const ground = `M${x(0)},${y(lo)}L${skyline.join("L")}L${x(360).toFixed(1)},${y(h[0]).toFixed(1)}L${x(360)},${y(lo)}Z`;
  const dots = (pick: (s: Sample) => { azimuth_deg: number; elevation_deg: number }, cls: string) =>
    samples.map((s, i) => {
      const d = pick(s);
      return <circle key={`${cls}${i}`} className={cls} cx={x(d.azimuth_deg)} cy={y(d.elevation_deg)} r={1.4} />;
    });
  return (
    <svg className="timeline horizon-profile" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Terrain horizon elevation versus azimuth, with the Sun and Earth paths">
      <path className="ground" d={ground} />
      <line className="horizon" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
      {[lo, 0, hi].map((deg) => (
        <text key={deg} className="axis" x={PAD.l - 6} y={y(deg) + 4} textAnchor="end">{deg}°</text>
      ))}
      {COMPASS.map((label, i) => (
        <text key={i} className="axis" x={x(i * 90)} y={H - 8} textAnchor="middle">{label} {i * 90 === 360 ? "" : `${i * 90}°`}</text>
      ))}
      {dots((s) => s.sun, "dot-sun")}
      {dots((s) => s.earth, "dot-earth")}
    </svg>
  );
}
