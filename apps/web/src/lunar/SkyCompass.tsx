// Local compass at the scenario site: N arrow, Sun (yellow) and Earth (blue) on the horizon circle at
// their azimuth. Filled dot = centre above the ideal horizon, hollow = below. Geometric only.

import type { AzEl } from "./skyGeometry";

const R = 38;
const C = 50;
const ARROW = `M${C} ${C - 22} L${C - 7} ${C - 8} L${C - 2.5} ${C - 8} L${C - 2.5} ${C + 14} L${C + 2.5} ${C + 14} L${C + 2.5} ${C - 8} L${C + 7} ${C - 8} Z`;

function Dot({ v, color, label }: { v: AzEl; color: string; label: string }) {
  const a = (v.azimuthDeg * Math.PI) / 180;
  const up = v.elevationDeg > 0;
  return (
    <circle
      cx={C + R * Math.sin(a)}
      cy={C - R * Math.cos(a)}
      r={7}
      fill={up ? color : "#000"}
      stroke={color}
      strokeWidth={2}
      opacity={up ? 1 : 0.6}
    >
      <title>{`${label}: az ${az(v, 1)}°, el ${v.elevationDeg.toFixed(1)}°`}</title>
    </circle>
  );
}

/** Rounded azimuth, wrapped so 359.99… never prints as 360. */
const az = (v: AzEl, digits: number) => (Number(v.azimuthDeg.toFixed(digits)) % 360).toFixed(digits);
const fmt = (v: AzEl) => `az ${az(v, 0)}° · el ${v.elevationDeg >= 0 ? "+" : ""}${v.elevationDeg.toFixed(1)}°`;

export function SkyCompass({ sun, earth }: { sun: AzEl; earth: AzEl }) {
  return (
    <div className="sky-compass">
      <svg viewBox="0 0 100 100" width={100} height={100} role="img" aria-label="Sun and Earth azimuth at the site">
        <g>
          <circle cx={C} cy={C} r={R} fill="none" stroke="#fff" strokeWidth={2} />
          <text x={C} y={12} textAnchor="middle" fill="#ddd" fontSize={13} fontWeight={700}>
            N
          </text>
          <path d={ARROW} fill="#ff2a2a" />
          <Dot v={earth} color="#1e90ff" label="Earth" />
          <Dot v={sun} color="#ffd400" label="Sun" />
        </g>
      </svg>
      <div className="sky-compass-read">
        <span className="sun">●</span> Sun {fmt(sun)}
        <br />
        <span className="earth">●</span> Earth {fmt(earth)}
      </div>
    </div>
  );
}
