"use client";

import { useEffect, useState } from "react";

type HealthResponse = {
  web: string;
  requestId: string;
  agent: unknown;
  agentOk: boolean;
};

// Dev-only visibility into the request-tracing plumbing: fires /api/health on mount and logs
// the shared requestId to the browser console, matching the same id logged server-side by
// apps/web (middleware.ts) and services/agent (logging_setup.py) — grep for it across all three.
export function SystemStatus() {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json() as Promise<HealthResponse>)
      .then((data) => {
        console.log(`[trace ${data.requestId}] /api/health ->`, data);
        setHealth(data);
      })
      .catch((error) => console.error("[trace] /api/health failed", error));
  }, []);

  if (!health) return null;

  return (
    <p className="mt-4 text-xs text-zinc-500" data-testid="system-status">
      web: {health.web} · agent: {health.agentOk ? "ok" : "unreachable"} · trace:{" "}
      {health.requestId}
    </p>
  );
}
