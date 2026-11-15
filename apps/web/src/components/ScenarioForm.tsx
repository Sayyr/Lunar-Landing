import type { PresetSite, ScenarioRequest, TerrainMode } from "../api/types";
import { LANDING_SITES, landingLabel } from "../lunar/landingSites";

interface Props {
  value: ScenarioRequest;
  onChange: (next: ScenarioRequest) => void;
  sites: PresetSite[];
  busy: boolean;
  onEvaluate: () => void;
  onSynthetic: () => void;
  onSiteChosen?: (lat: number, lon: number) => void;
}

function NumberField(props: {
  label: string;
  title?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label title={props.title}>
      {props.label}
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        onChange={(e) => props.onChange(e.target.valueAsNumber)}
      />
    </label>
  );
}

// <input type="datetime-local"> has no timezone; we treat its value as UTC explicitly.
const toLocalInput = (utc: string) => utc.slice(0, 16);
const fromLocalInput = (v: string) => `${v}:00Z`;

export function ScenarioForm({ value, onChange, sites, busy, onEvaluate, onSynthetic, onSiteChosen }: Props) {
  const site = value.site;
  const setSite = (patch: Partial<ScenarioRequest["site"]>) => onChange({ ...value, site: { ...site, ...patch } });

  return (
    <form className="form" onSubmit={(e) => e.preventDefault()}>
      <label>
        Site
        <select
          value=""
          onChange={(e) => {
            const v = e.target.value;
            const [kind, id] = [v.slice(0, v.indexOf(":")), v.slice(v.indexOf(":") + 1)];
            const s = kind === "landing" ? LANDING_SITES.find((x) => x.id === id) : undefined;
            const p = kind === "preset" ? sites.find((x) => x.id === id) : undefined;
            const chosen = s ? { lat: s.lat, lon: s.lon } : p ? { lat: p.latitude_deg, lon: p.longitude_deg } : null;
            if (!chosen) return;
            setSite({ latitude_deg: chosen.lat, longitude_deg: chosen.lon });
            onSiteChosen?.(chosen.lat, chosen.lon);
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
      </label>
      <div className="grid3">
        <NumberField label="Latitude (°)" title="Planetocentric" value={site.latitude_deg} min={-90} max={90} step={0.1}
          onChange={(v) => setSite({ latitude_deg: v })} />
        <NumberField label="Longitude (°E)" title="East-positive, [-180, 180)" value={site.longitude_deg} min={-180} max={179.999} step={0.1}
          onChange={(v) => setSite({ longitude_deg: v })} />
        <NumberField label="Height (m)" title="Observer height above the surface" value={site.observer_height_m} min={0} max={1000} step={0.5}
          onChange={(v) => setSite({ observer_height_m: v })} />
      </div>
      <label>
        Start (UTC)
        <input
          type="datetime-local"
          value={toLocalInput(value.start_utc)}
          onChange={(e) => e.target.value && onChange({ ...value, start_utc: fromLocalInput(e.target.value) })}
        />
      </label>
      <div className="grid2">
        <NumberField label="Duration (h)" value={value.duration_hours} min={1} max={2160} step={1}
          onChange={(v) => onChange({ ...value, duration_hours: v })} />
        <NumberField label="Step (min)" value={value.step_minutes} min={1} max={1440} step={1}
          onChange={(v) => onChange({ ...value, step_minutes: v })} />
      </div>
      <label>
        Horizon model
        <select value={value.terrain_mode} onChange={(e) => onChange({ ...value, terrain_mode: e.target.value as TerrainMode })}>
          <option value="ideal">Ideal geometric horizon</option>
          <option value="dem">DEM terrain horizon (not available)</option>
        </select>
      </label>
      <div className="actions">
        <button type="button" disabled={busy} onClick={onEvaluate}>
          Evaluate (real ephemerides)
        </button>
        <button type="button" className="synthetic-btn" disabled={busy} onClick={onSynthetic}>
          Load SYNTHETIC demo data
        </button>
      </div>
    </form>
  );
}
