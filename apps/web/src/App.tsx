import { useEffect, useState } from "react";

import { api, ApiError } from "./api/client";
import type { PresetSite, ScenarioRequest, ScenarioResponse } from "./api/types";
import { MoonGlobe } from "./components/MoonGlobe";
import { ResultPanel } from "./components/ResultPanel";
import { ScenarioForm } from "./components/ScenarioForm";
import { ServiceStatus } from "./components/ServiceStatus";

// Synthetic example from CLAUDE.md — not a recommended landing site.
const DEFAULT_REQUEST: ScenarioRequest = {
  site: { latitude_deg: -89.5, longitude_deg: 0, observer_height_m: 2 },
  start_utc: "2026-11-15T00:00:00Z",
  duration_hours: 72,
  step_minutes: 10,
  terrain_mode: "ideal",
};

export function App() {
  const [request, setRequest] = useState(DEFAULT_REQUEST);
  const [sites, setSites] = useState<PresetSite[]>([]);
  const [result, setResult] = useState<ScenarioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.sites().then(setSites).catch(() => setSites([]));
  }, []);

  const run = async (call: (r: ScenarioRequest) => Promise<ScenarioResponse>) => {
    setBusy(true);
    setError(null);
    try {
      setResult(await call(request));
    } catch (e) {
      setResult(null);
      if (e instanceof ApiError && e.body) {
        const d = e.body.error.details.map((x) => `${x.field}: ${x.issue}`).join("; ");
        setError(`${e.body.error.code}: ${e.body.error.message}${d ? ` (${d})` : ""}`);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>SELENE</h1>
          <p className="subtitle">Lunar landing site &amp; date navigator — NASA Space Apps 2026 (prototype)</p>
        </div>
        <ServiceStatus />
      </header>
      <main className="layout">
        <MoonGlobe
          latitudeDeg={request.site.latitude_deg}
          longitudeDeg={request.site.longitude_deg}
          onPick={(lat, lon) => setRequest({ ...request, site: { ...request.site, latitude_deg: lat, longitude_deg: lon } })}
        />
        <div className="side">
          <ScenarioForm
            value={request}
            onChange={setRequest}
            sites={sites}
            busy={busy}
            onEvaluate={() => run(api.evaluate)}
            onSynthetic={() => run(api.evaluateSynthetic)}
          />
          {error && <div className="error" role="alert">{error}</div>}
          {result && <ResultPanel result={result} />}
        </div>
      </main>
      <footer className="foot">
        Geometric visibility is not a power or communications guarantee. Not NASA-certified; not flight-ready.
      </footer>
    </div>
  );
}
