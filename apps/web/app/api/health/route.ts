import { NextRequest, NextResponse } from "next/server";
import { loggerFor } from "@/lib/logger";

// Demonstrates end-to-end tracing: the same x-request-id set by middleware.ts is logged here,
// forwarded to services/agent, logged there too, and echoed back for the browser console log
// in app/page.tsx — so one request is greppable across all three layers by a single UUID.
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? "unknown";
  const log = loggerFor(requestId);
  log.info({ route: "/api/health" }, "web received health check");

  const agentUrl = process.env.AGENT_SERVICE_URL ?? "http://localhost:8000";
  let agentStatus: unknown = null;
  let agentOk = false;

  try {
    const agentResponse = await fetch(`${agentUrl}/health`, {
      headers: { "x-request-id": requestId },
      cache: "no-store",
    });
    agentOk = agentResponse.ok;
    agentStatus = await agentResponse.json();
  } catch (error) {
    log.error({ err: error }, "agent service unreachable");
  }

  log.info({ agentOk, agentStatus }, "web returning health check");

  return NextResponse.json(
    { web: "ok", requestId, agent: agentStatus, agentOk },
    { headers: { "x-request-id": requestId } },
  );
}
