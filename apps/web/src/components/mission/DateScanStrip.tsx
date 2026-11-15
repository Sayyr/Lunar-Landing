// Nearby landing dates (date_scan): one cell per re-simulated date, green = go, red = no go,
// amber = incomplete. The planned date is outlined, the proposed one starred. Click to pick a date.
import type { DateScan } from "../../api/missionTypes";

const fmtDate = (iso: string) => iso.slice(5, 16).replace("T", " ");

export function DateScanStrip({ scan, proposed, onPick }: { scan: DateScan; proposed: string | null; onPick: (landingUtc: string) => void }) {
  const go = scan.points.filter((p) => p.verdict === "go").length;
  return (
    <div className="date-scan">
      <div className="date-scan-cells" role="list">
        {scan.points.map((p) => (
          <button
            key={p.landing_utc}
            type="button"
            role="listitem"
            className={`date-cell verdict-cell-${p.verdict}${p.offset_hours === 0 ? " planned" : ""}${p.landing_utc === proposed ? " proposed" : ""}`}
            title={`${p.landing_utc.slice(0, 16).replace("T", " ")} UTC (${p.offset_hours >= 0 ? "+" : ""}${(p.offset_hours / 24).toFixed(2)} d): ${p.verdict.replace("_", " ")}${p.failed.length ? ` — failed: ${p.failed.join(", ")}` : ""}`}
            onClick={() => onPick(p.landing_utc)}
          >
            {p.landing_utc === proposed ? "★" : ""}
          </button>
        ))}
      </div>
      <div className="date-scan-axis small muted">
        <span>{fmtDate(scan.points[0].landing_utc)}</span>
        <span>planned ▢ · proposed ★ · {go}/{scan.points.length} dates pass (step {scan.step_hours} h)</span>
        <span>{fmtDate(scan.points[scan.points.length - 1].landing_utc)}</span>
      </div>
    </div>
  );
}
