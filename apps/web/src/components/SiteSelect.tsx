import type { PresetSite } from "../api/types";
import { LANDING_SITES, landingLabel } from "../lunar/landingSites";

/** "Choose a site" list: past soft landings (LROC) and the API's synthetic test points. */
export function SiteSelect({ sites, onChosen }: { sites: PresetSite[]; onChosen: (lat: number, lon: number) => void }) {
  return (
    <select
      value=""
      onChange={(e) => {
        const v = e.target.value;
        const [kind, id] = [v.slice(0, v.indexOf(":")), v.slice(v.indexOf(":") + 1)];
        const s = kind === "landing" ? LANDING_SITES.find((x) => x.id === id) : undefined;
        const p = kind === "preset" ? sites.find((x) => x.id === id) : undefined;
        if (s) onChosen(s.lat, s.lon);
        else if (p) onChosen(p.latitude_deg, p.longitude_deg);
      }}
    >
      <option value="">— choose a site —</option>
      <optgroup label="Past soft landings (LROC)">
        {LANDING_SITES.map((s) => (
          <option key={s.id} value={`landing:${s.id}`}>
            {landingLabel(s)}
          </option>
        ))}
      </optgroup>
      {sites.length > 0 && (
        <optgroup label="Synthetic test points">
          {sites.map((s) => (
            <option key={s.id} value={`preset:${s.id}`} title={s.notes}>
              {s.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
