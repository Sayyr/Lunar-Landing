import { niceScale } from "../lib/scaleBar";

/**
 * Scale bar for a perspective view: valid at the view centre only (perspective changes the scale
 * across the screen). `kmPerPx` null = no metric scale (schematic view): `fallback` is shown.
 */
export function ScaleBar({ kmPerPx, note, fallback }: { kmPerPx: number | null; note: string; fallback?: string }) {
  const s = kmPerPx == null ? null : niceScale(kmPerPx);
  return (
    <div className="scale-bar" title={note}>
      {s ? (
        <>
          <div className="scale-bar-line" style={{ width: `${s.px.toFixed(1)}px` }} />
          <span>{s.label}</span>
          <small>{note}</small>
        </>
      ) : (
        <span>{fallback ?? "—"}</span>
      )}
    </div>
  );
}
