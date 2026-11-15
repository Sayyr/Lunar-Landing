import type { Sample, VisibilityWindow } from "../api/types";

interface Props {
  samples: Sample[];
  sunWindows: VisibilityWindow[];
  earthWindows: VisibilityWindow[];
  watermark?: string;
}

const W = 720;
const H = 240;
const PAD = { l: 44, r: 12, t: 12, b: 28 };

export function Timeline({ samples, sunWindows, earthWindows, watermark }: Props) {
  if (samples.length < 2) return null;
  const t = samples.map((s) => Date.parse(s.utc));
  const t0 = t[0];
  const t1 = t[t.length - 1];
  const els = samples.flatMap((s) => [s.sun.elevation_deg, s.earth.elevation_deg, s.sun.horizon_elevation_deg ?? 0, s.earth.horizon_elevation_deg ?? 0]);
  const yMax = Math.max(1, ...els.map(Math.abs)) * 1.15;

  const x = (ms: number) => PAD.l + ((ms - t0) / (t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (deg: number) => PAD.t + ((yMax - deg) / (2 * yMax)) * (H - PAD.t - PAD.b);
  const path = (pick: (s: Sample) => number) =>
    samples.map((s, i) => `${i ? "L" : "M"}${x(t[i]).toFixed(1)},${y(pick(s)).toFixed(1)}`).join("");
  // DEM terrain horizon at each body's azimuth (present only with the terrain horizon model).
  const hasTerrain = samples[0].sun.horizon_elevation_deg !== undefined;
  const band = (w: VisibilityWindow, cls: string, top: number, i: number) => {
    const a = x(Date.parse(w.start_utc));
    return <rect key={`${cls}${i}`} className={cls} x={a} y={top} width={x(Date.parse(w.end_utc)) - a} height={6} />;
  };
  const hours = (t1 - t0) / 3.6e6;
  const tickEvery = hours > 96 ? 24 : hours > 24 ? 12 : 6;
  const ticks = Array.from({ length: Math.floor(hours / tickEvery) + 1 }, (_, i) => t0 + i * tickEvery * 3.6e6);

  return (
    <svg className="timeline" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Elevation versus time">
      {watermark && (
        <text className="watermark" x={W / 2} y={H / 2} textAnchor="middle">
          {watermark}
        </text>
      )}
      <line className="horizon" x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
      <text className="axis" x={PAD.l - 6} y={y(0) + 4} textAnchor="end">0°</text>
      <text className="axis" x={PAD.l - 6} y={y(yMax / 1.15) + 4} textAnchor="end">{(yMax / 1.15).toFixed(1)}°</text>
      <text className="axis" x={PAD.l - 6} y={y(-yMax / 1.15) + 4} textAnchor="end">{(-yMax / 1.15).toFixed(1)}°</text>
      {ticks.map((ms) => (
        <text key={ms} className="axis" x={x(ms)} y={H - 8} textAnchor="middle">
          +{Math.round((ms - t0) / 3.6e6)} h
        </text>
      ))}
      {sunWindows.map((w, i) => band(w, "band-sun", PAD.t, i))}
      {earthWindows.map((w, i) => band(w, "band-earth", PAD.t + 8, i))}
      {hasTerrain && (
        <>
          <path className="line-sun terrain" d={path((s) => s.sun.horizon_elevation_deg ?? 0)} />
          <path className="line-earth terrain" d={path((s) => s.earth.horizon_elevation_deg ?? 0)} />
        </>
      )}
      <path className="line-sun" d={path((s) => s.sun.elevation_deg)} />
      <path className="line-earth" d={path((s) => s.earth.elevation_deg)} />
    </svg>
  );
}
