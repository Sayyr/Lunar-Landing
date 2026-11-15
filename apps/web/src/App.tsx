import { lazy, Suspense, useEffect, useState } from "react";

import { api, ApiError } from "./api/client";
import type { PresetSite, ScenarioRequest, ScenarioResponse } from "./api/types";
import { ResultPanel } from "./components/ResultPanel";
import { ScenarioForm } from "./components/ScenarioForm";
import { ServiceStatus } from "./components/ServiceStatus";
import { REPO_URL } from "./lib/links";
import { LunarExplorer } from "./lunar/LunarExplorer";
import { RadioLinkPanel } from "./components/RadioLinkPanel";
import { ComparePanel } from "./components/ComparePanel";
import { DelaySweepPanel } from "./components/DelaySweepPanel";
import { LandingSitesPage } from "./components/LandingSitesPage";
import { SouthPoleGridPage } from "./components/SouthPoleGridPage";
import { MissionPage } from "./components/mission/MissionPage";
import { CreateMission } from "./components/mission/CreateMission";
import type { MissionDraft, SavedMission } from "./lib/mission";
import type { TrajectoryView } from "./lib/trajectory";

const CelestialDashboard = lazy(() =>
  import("./components/celestial/CelestialDashboard").then((m) => ({ default: m.CelestialDashboard })),
);

type Tab = "scenario" | "sky" | "sites" | "grid" | "mission";
const tabFromHash = (): Tab => {
  const h = window.location.hash;
  return h === "#/sky" ? "sky" : h === "#/sites" ? "sites" : h === "#/grid" ? "grid" : h === "#/mission" ? "mission" : "scenario";
};

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
  const [focus, setFocus] = useState<{ lat: number; lon: number; seq: number } | null>(null);
  const [result, setResult] = useState<ScenarioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [skyOpened, setSkyOpened] = useState(tab === "sky");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<MissionDraft | null>(null);
  // Earth→Moon trajectory, shared by the Mission page and the Sun · Earth · Moon page.
  const [trajectory, setTrajectory] = useState<TrajectoryView | null>(null);
  // Named missions (Mission page), picked by name on the Sun · Earth · Moon page.
  const [missions, setMissions] = useState<SavedMission[]>([]);
  const [skyFocus, setSkyFocus] = useState<{ utc: string; seq: number } | null>(null);
  if (tab === "sky" && !skyOpened) setSkyOpened(true);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    api.sites(ctrl.signal).then(setSites).catch(() => setSites([]));
    return () => ctrl.abort();
  }, []);

  const showOnGlobe = (lat: number, lon: number) => {
    setRequest((r) => ({ ...r, site: { ...r.site, latitude_deg: lat, longitude_deg: lon } }));
    setFocus((f) => ({ lat, lon, seq: (f?.seq ?? 0) + 1 }));
    window.location.hash = "#/";
  };

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
        <h1>SELENE</h1>
        <nav className="tabs" aria-label="Views">
          <a href="#/" className={tab === "scenario" ? "active" : ""}>Site scenario</a>
          <a href="#/sky" className={tab === "sky" ? "active" : ""}>Sun · Earth · Moon</a>
          <a href="#/sites" className={tab === "sites" ? "active" : ""}>Landing sites</a>
          <a href="#/grid" className={tab === "grid" ? "active" : ""}>South-pole grid</a>
          <a href="#/mission" className={tab === "mission" ? "active" : ""}>Mission</a>
        </nav>
      </header>
      {/* Both views stay mounted (hidden + paused) so switching tabs keeps the globe, its GPU data and state. */}
      <main className="dash-main" hidden={tab !== "sky"}>
        {skyOpened && (
          <Suspense fallback={null}>
            <CelestialDashboard active={tab === "sky"} site={request.site} missions={missions} trajectory={trajectory} onTrajectory={setTrajectory} focus={skyFocus} />
          </Suspense>
        )}
      </main>
      <main className="sites-main" hidden={tab !== "sites"}>
        <LandingSitesPage
          active={tab === "sites"}
          onShow={(s) => showOnGlobe(s.lat, s.lon)}
        />
      </main>
      <main className="sites-main" hidden={tab !== "grid"}>
        <SouthPoleGridPage active={tab === "grid"} onShow={(lat, lon) => showOnGlobe(lat, lon)} />
      </main>
      <main className="sites-main" hidden={tab !== "mission"}>
        <MissionPage
          active={tab === "mission"}
          scenario={request}
          onScenario={setRequest}
          draft={draft}
          saved={missions}
          onSaved={setMissions}
          trajectory={trajectory}
          onTrajectory={setTrajectory}
          onShowTrajectory={(utc) => {
            setSkyFocus((f) => ({ utc, seq: (f?.seq ?? 0) + 1 }));
            setSkyOpened(true);
            window.location.hash = "#/sky";
          }}
        />
      </main>
      <main className="scenario-main" hidden={tab !== "scenario"}>
        {creating ? (
          <CreateMission
            scenario={request}
            onScenario={setRequest}
            sites={sites}
            onFocus={(lat, lon) => setFocus((f) => ({ lat, lon, seq: (f?.seq ?? 0) + 1 }))}
            onClose={() => setCreating(false)}
            onCreate={(d) => {
              setDraft((p) => ({ ...d, seq: (p?.seq ?? 0) + 1 }));
              setCreating(false);
              window.location.hash = "#/mission";
            }}
          />
        ) : (
          <button type="button" className="primary create-mission-btn" onClick={() => setCreating(true)}>
            Create mission
          </button>
        )}
        <LunarExplorer
          active={tab === "scenario"}
          siteLat={request.site.latitude_deg}
          siteLon={request.site.longitude_deg}
          onPick={(lat, lon) => setRequest((r) => ({ ...r, site: { ...r.site, latitude_deg: lat, longitude_deg: lon } }))}
          startUtc={request.start_utc}
          durationHours={request.duration_hours}
          stepMinutes={request.step_minutes}
          observerHeightM={request.site.observer_height_m}
          focus={focus}
        >
          {/* Scenario settings and results live in the explorer's "⋯" panel. */}
          <ScenarioForm
            value={request}
            onChange={setRequest}
            sites={sites}
            busy={busy}
            onEvaluate={() => run(api.evaluate)}
            onSynthetic={() => run(api.evaluateSynthetic)}
            onSiteChosen={(lat, lon) => setFocus((f) => ({ lat, lon, seq: (f?.seq ?? 0) + 1 }))}
          />
          {error && <div className="error" role="alert">{error}</div>}
          {result && <ResultPanel result={result} />}
          <ComparePanel scenario={request} />
          <DelaySweepPanel scenario={request} />
          <RadioLinkPanel scenario={request} />
          <ServiceStatus />
          <p className="muted small">
            Geometric visibility is not a power or communications guarantee. Not NASA-certified; not flight-ready.
          </p>
        </LunarExplorer>
      </main>
      <a className="repo-link" href={REPO_URL} target="_blank" rel="noopener noreferrer" title="Source on GitHub">
        <svg viewBox="0 0 16 16" width={18} height={18} aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
          />
        </svg>
        GitHub
      </a>
    </div>
  );
}
