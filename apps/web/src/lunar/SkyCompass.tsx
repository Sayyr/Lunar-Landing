// Sky plot at the scenario site, drawn as a compass lying on the local horizon:
//   - centre = zenith, ring = ideal horizon, dashed circles = 30° and 60° elevation;
//   - Sun (yellow) and Earth (blue) at their azimuth, closer to the centre the higher they are;
//     below the horizon they sit just outside the ring, hollow;
//   - the parent rotates the flat disc, the same way in every view: N to the on-screen north at
//     the site (orbit view), or the top to where the observer looks (ground view).
// Geometric directions only (ideal horizon, centre of each disc).

import type { Ref } from "react";

import type { AzEl } from "./skyGeometry";

const R = 46; // horizon ring radius (viewBox units)
const DEG = Math.PI / 180;

/** Sky-plot position: radius ∝ zenith distance; below the horizon, just outside the ring. */
export function skyPlotXY(v: AzEl, ringRadius = R): { x: number; y: number; up: boolean } {
  const up = v.elevationDeg > 0;
  const r = up ? (ringRadius * (90 - v.elevationDeg)) / 90 : ringRadius + 7;
  const a = v.azimuthDeg * DEG;
  return { x: r * Math.sin(a), y: -r * Math.cos(a), up };
}

/** Rounded azimuth, wrapped so 359.99… never prints as 360. */
const az = (v: AzEl, digits: number) => (Number(v.azimuthDeg.toFixed(digits)) % 360).toFixed(digits);
const fmt = (v: AzEl) => `az ${az(v, 0)}° · el ${v.elevationDeg >= 0 ? "+" : ""}${v.elevationDeg.toFixed(1)}°`;

function Ticks() {
  const ticks = [];
  for (let d = 0; d < 360; d += 10) {
    const major = d % 90 === 0;
    const mid = d % 30 === 0;
    const r0 = R - (major ? 7 : mid ? 5 : 3);
    const a = d * DEG;
    ticks.push(
      <line
        key={d}
        x1={r0 * Math.sin(a)}
        y1={-r0 * Math.cos(a)}
        x2={R * Math.sin(a)}
        y2={-R * Math.cos(a)}
        stroke={d === 0 ? "#ff4d4d" : "#cfd6e4"}
        strokeWidth={major ? 1.6 : 0.8}
        opacity={major || mid ? 0.9 : 0.5}
      />,
    );
  }
  return <>{ticks}</>;
}

function Body({ v, kind }: { v: AzEl; kind: "sun" | "earth" }) {
  const p = skyPlotXY(v);
  const label = `${kind === "sun" ? "Sun" : "Earth"}: ${fmt(v)}`;
  if (kind === "sun") {
    return (
      <g transform={`translate(${p.x} ${p.y})`} opacity={p.up ? 1 : 0.55}>
        <title>{label}</title>
        {p.up && <circle r={9} fill="url(#sun-glow)" />}
        {Array.from({ length: 8 }, (_, i) => (
          <line key={i} x1={0} y1={-5.5} x2={0} y2={-8} stroke="#ffd400" strokeWidth={1.1} transform={`rotate(${i * 45})`} />
        ))}
        <circle r={4} fill={p.up ? "#ffd400" : "#000"} stroke="#ffd400" strokeWidth={1.4} />
      </g>
    );
  }
  return (
    <g transform={`translate(${p.x} ${p.y})`} opacity={p.up ? 1 : 0.55}>
      <title>{label}</title>
      <circle r={4.6} fill={p.up ? "url(#earth-fill)" : "#000"} stroke="#4aa3ff" strokeWidth={1.4} />
    </g>
  );
}

/**
 * `diskRef` receives the element the parent rotates (CSS transform), on every camera move,
 * without re-rendering React.
 */
export function SkyCompass({ sun, earth, diskRef }: { sun: AzEl; earth: AzEl; diskRef?: Ref<HTMLDivElement> }) {
  return (
    <div className="sky-compass">
      <div className="sky-compass-stage">
        <div ref={diskRef} className="sky-compass-disk">
          <svg viewBox="-62 -62 124 124" role="img" aria-label="Sky plot: Sun and Earth azimuth and elevation at the site">
            <defs>
              <radialGradient id="compass-face" r="0.5">
                <stop offset="0" stopColor="#1b2433" stopOpacity="0.85" />
                <stop offset="1" stopColor="#05070b" stopOpacity="0.85" />
              </radialGradient>
              <radialGradient id="sun-glow" r="0.5">
                <stop offset="0" stopColor="#ffe680" stopOpacity="0.9" />
                <stop offset="1" stopColor="#ffd400" stopOpacity="0" />
              </radialGradient>
              <radialGradient id="earth-fill" cx="0.35" cy="0.35" r="0.7">
                <stop offset="0" stopColor="#9fd0ff" />
                <stop offset="1" stopColor="#1e5fbf" />
              </radialGradient>
            </defs>
            <circle r={R} fill="url(#compass-face)" stroke="#cfd6e4" strokeWidth={1.4} />
            <circle r={(R * 60) / 90} fill="none" stroke="#cfd6e4" strokeWidth={0.6} strokeDasharray="2 3" opacity={0.45} />
            <circle r={(R * 30) / 90} fill="none" stroke="#cfd6e4" strokeWidth={0.6} strokeDasharray="2 3" opacity={0.45} />
            <Ticks />
            {/* north pointer outside the ring */}
            <path d={`M0 ${-R - 12} L-5 ${-R - 3} L5 ${-R - 3} Z`} fill="#ff4d4d" />
            {(["N", "E", "S", "W"] as const).map((c, i) => (
              <text
                key={c}
                x={(R - 15) * Math.sin(i * 90 * DEG)}
                y={-(R - 15) * Math.cos(i * 90 * DEG) + 3.5}
                textAnchor="middle"
                fontSize={10}
                fontWeight={700}
                fill={c === "N" ? "#ff4d4d" : "#e6e8ee"}
              >
                {c}
              </text>
            ))}
            <circle r={1.2} fill="#cfd6e4" opacity={0.7} />
            <Body v={earth} kind="earth" />
            <Body v={sun} kind="sun" />
          </svg>
        </div>
      </div>
      <div className="sky-compass-read">
        <span className="sun">●</span> Sun {fmt(sun)}
        <br />
        <span className="earth">●</span> Earth {fmt(earth)}
        <br />
        <small>centre = zenith · ring = horizon</small>
      </div>
    </div>
  );
}
