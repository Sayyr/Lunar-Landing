// Playback chart: approach (before the planned landing) + delay + surface stay. SoC line, Sun /
// Earth / link bands from the simulated timeline, first-violation markers and the playback cursor.
import type { MissionResponse } from "../../api/missionTypes";

const W = 760;
const H = 230;
const PAD = { l: 40, r: 12, t: 10, b: 26 };
const BAND_H = 9;

export interface PlaybackSpan {
  /** ms since epoch */
  start: number;
  end: number;
}

export function MissionTimeline({ result, span, cursor }: { result: MissionResponse; span: PlaybackSpan; cursor: number }) {
  const x = (t: number) => PAD.l + ((t - span.start) / (span.end - span.start)) * (W - PAD.l - PAD.r);
  const plotTop = PAD.t + 3 * (BAND_H + 3) + 4;
  const y = (soc: number) => plotTop + (1 - soc) * (H - plotTop - PAD.b);
  const planned = Date.parse(result.pre_landing.planned_landing_utc);
  const landing = Date.parse(result.pre_landing.landing_utc);
  const tl = result.timeline;
  const ts = tl.map((s) => Date.parse(s.utc));

  // Runs of consecutive true samples → rectangles (sample-resolution display of the timeline).
  const runs = (pick: (i: number) => boolean | null) => {
    const out: [number, number][] = [];
    let s = -1;
    for (let i = 0; i <= tl.length; i++) {
      const on = i < tl.length && pick(i) === true;
      if (on && s < 0) s = i;
      if (!on && s >= 0) {
        out.push([ts[s], ts[Math.min(i, tl.length - 1)]]);
        s = -1;
      }
    }
    return out;
  };
  const bands: { label: string; cls: string; spans: [number, number][] }[] = [
    { label: "Sun", cls: "band-sun", spans: runs((i) => tl[i].sun_visible) },
    { label: "Earth", cls: "band-earth", spans: runs((i) => tl[i].earth_visible) },
    ...(tl.some((s) => s.link_available !== null) ? [{ label: "Link", cls: "band-link", spans: runs((i) => tl[i].link_available) }] : []),
  ];
  const hasEnergy = tl.length > 0 && tl[0].soc !== null;
  const soc = hasEnergy ? tl.map((s, i) => `${i ? "L" : "M"}${x(ts[i]).toFixed(1)},${y(s.soc ?? 0).toFixed(1)}`).join("") : "";
  const reserve = result.inventory?.sizing?.reserve_soc ?? 0;
  const violations = result.constraints.filter((c) => c.first_violation_utc);
  const dayMs = 86_400_000;
  const ticks: number[] = [];
  const stepDays = Math.max(1, Math.ceil((span.end - span.start) / dayMs / 10));
  for (let t = Math.ceil(span.start / dayMs) * dayMs; t <= span.end; t += stepDays * dayMs) ticks.push(t);

  return (
    <svg className="timeline mission-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Mission playback timeline">
      {/* approach + delay */}
      <rect className="mission-approach" x={x(span.start)} y={PAD.t} width={Math.max(0, x(planned) - x(span.start))} height={H - PAD.t - PAD.b} />
      {landing > planned && (
        <rect className="mission-delay" x={x(planned)} y={PAD.t} width={x(landing) - x(planned)} height={H - PAD.t - PAD.b} />
      )}
      {bands.map((b, k) => (
        <g key={b.label}>
          <text className="axis" x={PAD.l - 4} y={PAD.t + k * (BAND_H + 3) + BAND_H - 1} textAnchor="end">{b.label}</text>
          {b.spans.map(([a, c]) => (
            <rect key={a} className={b.cls} x={x(a)} y={PAD.t + k * (BAND_H + 3)} width={Math.max(0.8, x(c) - x(a))} height={BAND_H} />
          ))}
        </g>
      ))}
      {hasEnergy && [0, 0.5, 1].map((f) => (
        <g key={f}>
          <line className="horizon" x1={PAD.l} x2={W - PAD.r} y1={y(f)} y2={y(f)} />
          <text className="axis" x={PAD.l - 4} y={y(f) + 3} textAnchor="end">{f * 100}%</text>
        </g>
      ))}
      {hasEnergy && reserve > 0 && <line className="mission-reserve" x1={PAD.l} x2={W - PAD.r} y1={y(reserve)} y2={y(reserve)} />}
      {hasEnergy && tl.length > 1 && <path className="mission-soc" d={soc} />}
      {!hasEnergy && (
        <text className="axis" x={W / 2} y={(plotTop + H - PAD.b) / 2} textAnchor="middle">
          Energy not modelled (optional) — Sun, Earth and link bands above
        </text>
      )}
      <line className="mission-landing" x1={x(landing)} x2={x(landing)} y1={PAD.t} y2={H - PAD.b} />
      <text className="axis" x={x(landing) + 3} y={H - PAD.b - 4}>landing</text>
      {violations.map((c) => {
        const t = Date.parse(c.first_violation_utc!);
        return (
          <g key={c.id}>
            <line className="mission-violation" x1={x(t)} x2={x(t)} y1={plotTop} y2={H - PAD.b} />
            <title>{`${c.label}: first violation ${c.first_violation_utc}`}</title>
          </g>
        );
      })}
      {ticks.map((t) => (
        <text key={t} className="axis" x={x(t)} y={H - 8} textAnchor="middle">
          {new Date(t).toISOString().slice(5, 10)}
        </text>
      ))}
      <line className="mission-cursor" x1={x(cursor)} x2={x(cursor)} y1={PAD.t - 4} y2={H - PAD.b + 4} />
      {result.synthetic && (
        <text className="watermark" x={W / 2} y={H / 2 + 20} textAnchor="middle">SYNTHETIC</text>
      )}
    </svg>
  );
}
