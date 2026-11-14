import { useEffect, useState } from "react";

import { api, ApiError } from "./api/client";
import type { PresetSite, ScenarioRequest, ScenarioResponse } from "./api/types";
import { ResultPanel } from "./components/ResultPanel";
import { ScenarioForm } from "./components/ScenarioForm";
import { ServiceStatus } from "./components/ServiceStatus";
import { CelestialDashboard } from "./components/celestial/CelestialDashboard";
import { LunarExplorer } from "./lunar/LunarExplorer";

type Tab = "scenario" | "sky";
const tabFromHash = (): Tab => (window.location.hash === "#/sky" ? "sky" : "scenario");

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
  const [tab, setTab] = useState<Tab>(tabFromHash);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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
        <nav className="tabs" aria-label="Views">
          <a href="#/" className={tab === "scenario" ? "active" : ""}>Site scenario</a>
          <a href="#/sky" className={tab === "sky" ? "active" : ""}>Sun · Earth · Moon</a>
        </nav>
        <ServiceStatus />
      </header>
      {/* Both views stay mounted (hidden + paused) so switching tabs keeps the globe, its GPU data and state. */}
      <main className="dash-main" hidden={tab !== "sky"}>
        <CelestialDashboard active={tab === "sky"} />
      </main>
      <main className="layout" hidden={tab !== "scenario"}>
        <LunarExplorer
          active={tab === "scenario"}
          siteLat={request.site.latitude_deg}
          siteLon={request.site.longitude_deg}
          onPick={(lat, lon) => setRequest((r) => ({ ...r, site: { ...r.site, latitude_deg: lat, longitude_deg: lon } }))}
          startUtc={request.start_utc}
          durationHours={request.duration_hours}
          stepMinutes={request.step_minutes}
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
