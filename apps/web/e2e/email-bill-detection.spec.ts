import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAILPIT_URL = "http://127.0.0.1:54324";
const AGENT_URL = "http://localhost:8000";

// The webhook Basic Auth credentials live in the repo-root .env.local (this file is a symlink
// target's sibling — apps/web/.env.local -> ../../.env.local), not in any Playwright-loaded env,
// since the Playwright process itself (not just the Next dev server it spawns) needs them to call
// the agent service directly, simulating what Postmark would send.
function readRootEnv(key: string): string {
  const contents = readFileSync(join(__dirname, "../../../.env.local"), "utf-8");
  const match = contents.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!match) throw new Error(`${key} not found in root .env.local — is the feature enabled locally?`);
  return match[1].trim();
}

async function getMagicLink(email: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=to:${email}`);
    const data = await res.json();
    if (data.messages?.length > 0) {
      const msgRes = await fetch(`${MAILPIT_URL}/api/v1/message/${data.messages[0].ID}`);
      const msg = await msgRes.json();
      const match = msg.Text.match(/\(\s*(http:\/\/[^\s)]+\/auth\/v1\/verify\?[^\s)]+)\s*\)/);
      if (match) return match[1];
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("magic link email never arrived");
}

test("toggling on email bill detection, an inbound bill lands in review, and approving it counts toward unpaid", async ({
  page,
}) => {
  test.setTimeout(180000);
  const email = `bill-detect-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });

  // Step 1: reach the dedicated setup page from the dashboard's top banner, and walk through the wizard.
  await page.getByTestId("email-detection-banner").click();
  await page.waitForURL("**/connect-email");
  await page.getByTestId("source-email-input").fill(email);
  await page.getByTestId("privacy-acknowledge-checkbox").check();
  await page.getByTestId("get-started-button").click();
  await expect(page.getByTestId("forwarding-address")).toBeVisible({ timeout: 10000 });
  const forwardingAddress = await page.getByTestId("forwarding-address").innerText();
  const token = forwardingAddress.split("@")[0];
  expect(token).toMatch(/^[a-f0-9]{32}$/);

  // Step 1b: simulate Gmail's forwarding-confirmation email and confirm the wizard relays the
  // code — this is the ONLY place the user ever sees it, since the forwarding address itself is
  // the thing being confirmed.
  const webhookUser = readRootEnv("INBOUND_EMAIL_WEBHOOK_USER");
  const webhookPassword = readRootEnv("INBOUND_EMAIL_WEBHOOK_PASSWORD");
  const auth = Buffer.from(`${webhookUser}:${webhookPassword}`).toString("base64");
  await fetch(`${AGENT_URL}/inbound-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      MessageID: `confirm-${Date.now()}`,
      Subject: "Gmail Forwarding Confirmation",
      TextBody: `You requested forwarding.\n\nConfirmation code: 4821093\n\nThis confirms forwarding to ${forwardingAddress}.`,
      OriginalRecipient: forwardingAddress,
    }),
  });
  await expect(page.getByTestId("confirmation-code")).toContainText("4821093", { timeout: 10000 });

  // Step 2: simulate Postmark POSTing an inbound bill email addressed to that forwarding address.
  const messageId = `e2e-${Date.now()}`;

  const webhookResponse = await fetch(`${AGENT_URL}/inbound-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      MessageID: messageId,
      Subject: "Your Skyline Internet bill is ready",
      TextBody:
        "Dear Customer,\n\nYour internet bill from Skyline Internet is now available.\n\nAmount Due: $79.99\nDue Date: 2026-10-10\n\nPlease pay by the due date.\n\nSkyline Internet\n55 Fiber Ave",
      OriginalRecipient: forwardingAddress,
    }),
  });
  const webhookResult = await webhookResponse.json();
  // The webhook now just enqueues the email and returns immediately (classify/extract runs in a
  // background task after the response, off the webhook's critical path — see
  // services/agent/email_bill_router.py) — so bill creation is no longer synchronous with this
  // response. Poll for the queue row to finish (Playwright's toBeVisible below also retries, but
  // polling the queue status directly gives a clearer failure if extraction itself is broken vs.
  // just slow).
  expect(webhookResult.status).toBe("queued");
  const serviceRoleKey = readRootEnv("SUPABASE_SERVICE_ROLE_KEY");
  await expect
    .poll(
      async () => {
        const rows = await fetch(
          `http://127.0.0.1:54321/rest/v1/inbound_email_queue?id=eq.${webhookResult.queue_id}&select=status`,
          { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } },
        ).then((r) => r.json());
        return rows[0]?.status;
      },
      { timeout: 90000, intervals: [500] },
    )
    .toBe("done");

  // Step 3: the bill shows up in the "pending review" queue, not yet counted as unpaid.
  await page.goto("/bills");
  await expect(page.getByTestId("pending-review-section")).toBeVisible();
  await expect(page.getByTestId("pending-review-row")).toContainText("Skyline Internet");
  const unpaidSummaryBefore = page.getByTestId("unpaid-summary");
  if (await unpaidSummaryBefore.isVisible()) {
    await expect(unpaidSummaryBefore).not.toContainText("79.99");
  }

  // Step 4: approve it — it should now show as a normal unpaid bill AND be counted in the total.
  await page.getByTestId("approve-detected-bill").click();
  await expect(page.getByTestId("pending-review-section")).not.toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("bill-row").filter({ hasText: "Skyline Internet" })).toBeVisible();
  await expect(page.getByTestId("unpaid-summary")).toContainText("79.99");

  // Step 5: idempotency — resubmitting the same MessageID must not create a duplicate bill.
  const retryResponse = await fetch(`${AGENT_URL}/inbound-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      MessageID: messageId,
      Subject: "resend",
      TextBody: "resend",
      OriginalRecipient: forwardingAddress,
    }),
  });
  const retryResult = await retryResponse.json();
  expect(retryResult.status).toBe("duplicate");
});

test("a bill detected before Gmail confirmation shows an already-working indicator, not a stuck waiting state", async ({
  page,
}) => {
  // Regression test for a real bug a naive-user test caught live: the wizard's "waiting for
  // confirmation" step never resolved even after detection had demonstrably worked, reading to a
  // real user as "setup failed" when it hadn't. Confirming in Gmail is for the user's own
  // benefit — it's not a prerequisite for us to actually detect bills.
  test.setTimeout(180000);
  const email = `bill-detect-nocode-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });

  await page.getByTestId("email-detection-banner").click();
  await page.waitForURL("**/connect-email");
  await page.getByTestId("source-email-input").fill(email);
  await page.getByTestId("privacy-acknowledge-checkbox").check();
  await page.getByTestId("get-started-button").click();
  await expect(page.getByTestId("forwarding-address")).toBeVisible({ timeout: 10000 });
  const forwardingAddress = await page.getByTestId("forwarding-address").innerText();

  // Deliberately skip the confirmation-code step entirely and go straight to forwarding a bill,
  // exactly like a real user who forwards something before ever checking Gmail's dialog.
  const webhookUser = readRootEnv("INBOUND_EMAIL_WEBHOOK_USER");
  const webhookPassword = readRootEnv("INBOUND_EMAIL_WEBHOOK_PASSWORD");
  const auth = Buffer.from(`${webhookUser}:${webhookPassword}`).toString("base64");
  await fetch(`${AGENT_URL}/inbound-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      MessageID: `nocode-${Date.now()}`,
      Subject: "Your Riverside Water bill",
      TextBody:
        "Dear Customer,\n\nYour water bill from Riverside Water is now available.\n\nAmount Due: $42.10\nDue Date: 2026-11-05\n\nRiverside Water\n1 Reservoir Way",
      OriginalRecipient: forwardingAddress,
    }),
  });

  // The confirmation step should still show it's waiting (never faked as done)...
  await expect(page.getByText(/Waiting for Gmail/i)).toBeVisible();
  // ...but the positive "already working" indicator should appear once a bill is actually
  // detected, rather than leaving the user thinking nothing happened.
  await expect(page.getByTestId("already-detecting")).toBeVisible({ timeout: 90000 });
  await expect(page.getByTestId("confirmation-code")).not.toBeVisible();
});
