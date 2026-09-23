import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Lets a user prove detection actually works without composing and forwarding a real email
// themselves — same shape as a real Postmark inbound payload, sent to the same webhook, so it
// exercises the exact code path a real forwarded bill would. Uses a fixed MessageID per user so
// clicking twice re-triggers rather than piling up duplicate test bills.
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const { data: forwarding } = await supabase
    .from("email_forwarding_addresses")
    .select("forwarding_token, enabled")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!forwarding?.enabled || !forwarding.forwarding_token) {
    return NextResponse.json({ error: "email detection is not enabled yet" }, { status: 400 });
  }

  const agentUrl = process.env.AGENT_SERVICE_URL ?? "http://localhost:8000";
  const webhookUser = process.env.INBOUND_EMAIL_WEBHOOK_USER ?? "";
  const webhookPassword = process.env.INBOUND_EMAIL_WEBHOOK_PASSWORD ?? "";
  const forwardingDomain = process.env.EMAIL_FORWARDING_DOMAIN;
  const auth = Buffer.from(`${webhookUser}:${webhookPassword}`).toString("base64");

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 14);
  const dueDateStr = dueDate.toISOString().slice(0, 10);

  const response = await fetch(`${agentUrl}/inbound-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      MessageID: `self-test-${user.id}`,
      Subject: "Your Sample Utility bill is ready",
      TextBody: `Dear Customer,\n\nYour bill from Sample Utility Co. is now available.\n\nAmount Due: $42.00\nDue Date: ${dueDateStr}\n\nSample Utility Co.\n1 Test Street`,
      OriginalRecipient: `${forwarding.forwarding_token}@${forwardingDomain}`,
    }),
  });

  if (!response.ok) {
    return NextResponse.json({ error: "test send failed" }, { status: 502 });
  }

  const result = await response.json();
  return NextResponse.json(result);
}
