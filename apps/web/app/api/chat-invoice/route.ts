import { NextRequest, NextResponse } from "next/server";
import { loggerFor } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? "unknown";
  const log = loggerFor(requestId);

  const body = await request.json();
  log.info({ turn: body.messages?.length }, "forwarding chat-invoice turn to agent");

  const agentUrl = process.env.AGENT_SERVICE_URL ?? "http://localhost:8000";
  const agentResponse = await fetch(`${agentUrl}/chat-invoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-request-id": requestId },
    body: JSON.stringify(body),
  });

  const data = await agentResponse.json();
  log.info({ status: agentResponse.status }, "agent chat-invoice response");

  return NextResponse.json(data, { status: agentResponse.status });
}
