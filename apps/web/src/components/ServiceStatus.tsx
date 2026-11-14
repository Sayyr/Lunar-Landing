import { useEffect, useState } from "react";

import { api } from "../api/client";
import type { HealthResponse } from "../api/types";

type State = { kind: "loading" } | { kind: "ok"; health: HealthResponse } | { kind: "down"; error: string };

const POLL_MS = 15_000;

function Badge({ label, ok, title }: { label: string; ok: boolean | null; title?: string }) {
  const cls = ok === null ? "badge pending" : ok ? "badge ok" : "badge bad";
  return (
    <span className={cls} title={title}>
      {label}
    </span>
  );
}

export function ServiceStatus() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    const poll = () =>
      api
        .health()
        .then((health) => alive && setState({ kind: "ok", health }))
        .catch((e: Error) => alive && setState({ kind: "down", error: e.message }));
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (state.kind === "loading") return <div className="status-row"><Badge label="API …" ok={null} /></div>;
  if (state.kind === "down")
    return (
      <div className="status-row">
        <Badge label="API unreachable" ok={false} title={state.error} />
      </div>
    );

  const { health } = state;
  const sci = health.upstream ?? null;
  const eph = sci?.ephemeris;
  return (
    <div className="status-row">
      <Badge label={`API ${health.version}`} ok />
      <Badge
        label={sci ? `Science ${sci.version}` : "Science unreachable"}
        ok={!!sci}
        title={health.upstream_error ?? undefined}
      />
      <Badge
        label={eph?.ready ? "Ephemerides ready" : "Ephemerides NOT ready"}
        ok={eph ? eph.ready : false}
        title={eph?.reason}
      />
    </div>
  );
}
