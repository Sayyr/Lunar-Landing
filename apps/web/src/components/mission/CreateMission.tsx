// "Create mission" card on the Site scenario page: landing site (list, coordinates or a click on the globe),
// planned landing date/time, vehicle mass and an optional solar array. Site and date edit the shared scenario;
// the rest goes to the Mission page, which runs the simulation (POST /scenarios/simulate).
import { useState } from "react";

import type { PresetSite, ScenarioRequest } from "../../api/types";
import type { MissionDraft } from "../../lib/mission";
import { SiteSelect } from "../SiteSelect";

interface Props {
  scenario: ScenarioRequest;
  onScenario: (s: ScenarioRequest) => void;
  sites: PresetSite[];
  /** fly the globe to a site picked from the list */
  onFocus: (lat: number, lon: number) => void;
  onCreate: (d: Omit<MissionDraft, "seq">) => void;
  onClose: () => void;
}

// Empty optional field → null.
const opt = (v: string) => (v.trim() === "" ? null : Number(v));

export function CreateMission({ scenario, onScenario, sites, onFocus, onCreate, onClose }: Props) {
  const [mass, setMass] = useState("");
  const [area, setArea] = useState("");
  const [eff, setEff] = useState("");
  const site = scenario.site;
  const setSite = (lat: number, lon: number) => onScenario({ ...scenario, site: { ...site, latitude_deg: lat, longitude_deg: lon } });

  return (
    <form
      className="form create-mission"
      aria-label="Create mission"
      onSubmit={(e) => {
        e.preventDefault();
        const a = opt(area);
        const pct = opt(eff);
        onCreate({ vehicleMassKg: Number(mass), panelAreaM2: a, panelEfficiency: a === null || pct === null ? null : pct / 100 });
      }}
    >
      <header>
        <h2>Create mission</h2>
        <button type="button" className="link-btn" onClick={onClose} aria-label="Close">✕</button>
      </header>
      <label>
        Landing site
        <SiteSelect
          sites={sites}
          onChosen={(lat, lon) => {
            setSite(lat, lon);
            onFocus(lat, lon);
          }}
        />
      </label>
      <div className="grid2">
        <label title="Planetocentric">
          Latitude (°)
          <input type="number" required min={-90} max={90} step="any" value={site.latitude_deg} onChange={(e) => setSite(e.target.valueAsNumber, site.longitude_deg)} />
        </label>
        <label title="East-positive, [-180, 180)">
          Longitude (°E)
          <input type="number" required min={-180} max={179.9999} step="any" value={site.longitude_deg} onChange={(e) => setSite(site.latitude_deg, e.target.valueAsNumber)} />
        </label>
      </div>
      <p className="muted small">…or click the Moon to place the site.</p>
      <label>
        Landing date &amp; time (UTC)
        {/* datetime-local has no timezone: its value is read as UTC. */}
        <input type="datetime-local" required step={60} value={scenario.start_utc.slice(0, 16)} onChange={(e) => e.target.value && onScenario({ ...scenario, start_utc: `${e.target.value}:00Z` })} />
      </label>
      <label>
        Vehicle mass (kg)
        <input type="number" required min={1} step="any" value={mass} onChange={(e) => setMass(e.target.value)} />
      </label>
      <div className="grid2">
        <label>
          Solar array area (m²) — optional
          <input type="number" min={0.01} step="any" value={area} onChange={(e) => setArea(e.target.value)} />
        </label>
        <label>
          Array efficiency (%) — optional
          <input type="number" min={1} max={100} step="any" disabled={area.trim() === ""} value={eff} onChange={(e) => setEff(e.target.value)} />
        </label>
      </div>
      <p className="muted small">
        No array area: energy is not modelled. Mass is kept with the mission but no model uses it yet (no propulsion or descent model).
      </p>
      <div className="actions">
        <button type="submit" className="primary">Create &amp; simulate</button>
      </div>
    </form>
  );
}
