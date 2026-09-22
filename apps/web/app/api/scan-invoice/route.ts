import { NextRequest, NextResponse } from "next/server";
import { loggerFor } from "@/lib/logger";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? "unknown";
  const log = loggerFor(requestId);

  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json({ error: "no file provided" }, { status: 400 });
  }

  log.info({ size: file.size, type: file.type }, "forwarding invoice image to agent");

  const agentUrl = process.env.AGENT_SERVICE_URL ?? "http://localhost:8000";
  const agentFormData = new FormData();
  // The agent's CSV/image detection falls back to the filename extension when the browser's
  // reported content-type isn't a clean match — renaming every upload to "upload" here silently
  // broke that fallback (the agent then depended entirely on an exact content-type match, which
  // isn't guaranteed for .csv across every OS/browser combination).
  const filename = file instanceof File ? file.name : "upload";
  agentFormData.append("file", file, filename);

  const agentResponse = await fetch(`${agentUrl}/scan-invoice`, {
    method: "POST",
    headers: { "x-request-id": requestId },
    body: agentFormData,
  });

  const data = await agentResponse.json();
  log.info({ status: agentResponse.status }, "agent scan response");

  return NextResponse.json(data, { status: agentResponse.status });
}
