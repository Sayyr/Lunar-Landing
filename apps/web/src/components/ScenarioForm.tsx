import type { PresetSite, ScenarioRequest, TerrainMode } from "../api/types";
import { SiteSelect } from "./SiteSelect";

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
        <SiteSelect
          sites={sites}
          onChosen={(lat, lon) => {
            setSite({ latitude_deg: lat, longitude_deg: lon });
            onSiteChosen?.(lat, lon);
          }}
        />
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
          <option value="dem">DEM terrain horizon (LOLA 20 m, 85°S–90°S)</option>
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
