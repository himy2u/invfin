import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * End-to-end cover for the round of bill-detection/reminder fixes: due-date ordering and urgency on
 * /bills, currency formatting, the in-app notification inbox, a reminder that stays visible and
 * editable after approval, the review table's column alignment, and the exact-date bounds check.
 *
 * Signs in by minting a real Supabase session for a throwaway user and injecting the cookie, rather
 * than the magic-link-through-Mailpit dance the older specs use. Those were written when this repo
 * pointed at a LOCAL Supabase (Mailpit on :54324); it points at the hosted project now, so there is
 * no local inbox to read a link out of. The cookie is the same `sb-<ref>-auth-token` blob
 * @supabase/ssr writes itself, so the app cannot tell the difference.
 */

const ENV = Object.fromEntries(
  readFileSync(path.join(__dirname, "../../../.env.local"), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const SUPABASE_URL = ENV.NEXT_PUBLIC_SUPABASE_URL;
const ANON = ENV.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SERVICE = ENV.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split(".")[0];

const svcHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };

async function rest(method: string, pathAndQuery: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: { ...svcHeaders, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${pathAndQuery} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : await res.json().catch(() => null);
}

function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function createSignedInPage(browser: Browser, label: string): Promise<{ page: Page; userId: string }> {
  const email = `e2e-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

  const created = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: svcHeaders,
    body: JSON.stringify({ email, password: crypto.randomUUID(), email_confirm: true }),
  });
  if (!created.ok) throw new Error(`admin create user failed: ${await created.text()}`);
  const userId: string = (await created.json()).id;

  const linked = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: svcHeaders,
    body: JSON.stringify({ type: "magiclink", email }),
  });
  const otp: string = (await linked.json()).email_otp;

  const verified = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", email, token: otp }),
  });
  if (!verified.ok) throw new Error(`verify failed: ${await verified.text()}`);
  const session = await verified.json();

  // Each test gets its own browser context, which is also what keeps two synthetic accounts from
  // colliding on one cookie jar, the exact failure a manual two-window run hit previously.
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: `sb-${PROJECT_REF}-auth-token`,
      value: "base64-" + Buffer.from(JSON.stringify(session)).toString("base64"),
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
  ]);
  return { page: await context.newPage(), userId };
}

type SeedBill = {
  vendor: string;
  number: string;
  cents: number;
  due: string | null;
  status: "unpaid" | "pending_review";
  currency?: string;
  reminderValue?: number;
  reminderUnit?: string;
};

/** Inserts bills directly. The Gemini extraction path that normally creates these has its own
 * coverage in services/agent; what is under test here is how the apps render and edit them. */
async function seedBills(userId: string, bills: SeedBill[]) {
  const rows = await rest(
    "POST",
    "bills",
    bills.map((b) => ({
      user_id: userId,
      bill_number: b.number,
      vendor_name: b.vendor,
      status: b.status,
      currency: b.currency ?? "USD",
      subtotal_cents: b.cents,
      total_cents: b.cents,
      due_date: b.due,
      issue_date: isoDaysFromToday(-1),
      source: "email",
      reminder_mode: "offset",
      reminder_offset_value: b.reminderValue ?? 2,
      reminder_offset_unit: b.reminderUnit ?? "days",
    })),
    { Prefer: "return=representation" },
  );
  return rows as { id: string; bill_number: string }[];
}

test.describe("bills list", () => {
  test("sorts by due date, flags urgency, and formats money with a currency symbol", async ({ browser }) => {
    const { page, userId } = await createSignedInPage(browser, "sort");
    await seedBills(userId, [
      { vendor: "Kestrel Property Mgmt", number: `KPM-${Date.now()}`, cents: 1490000, due: isoDaysFromToday(40), status: "unpaid" },
      { vendor: "Northgate Utilities", number: `NU-${Date.now()}`, cents: 41290, due: isoDaysFromToday(-4), status: "unpaid" },
      { vendor: "Meridian Insurance", number: `MI-${Date.now()}`, cents: 284050, due: isoDaysFromToday(3), status: "unpaid" },
      { vendor: "Loose End Supplies", number: `LE-${Date.now()}`, cents: 5000, due: null, status: "unpaid" },
    ]);

    await page.goto("/bills");
    const rows = page.getByTestId("bill-row");
    await expect(rows).toHaveCount(4);

    // Soonest due first; the bill with no due date sorts last rather than leading the list.
    await expect(rows.nth(0)).toContainText("Northgate Utilities");
    await expect(rows.nth(1)).toContainText("Meridian Insurance");
    await expect(rows.nth(2)).toContainText("Kestrel Property Mgmt");
    await expect(rows.nth(3)).toContainText("Loose End Supplies");

    await expect(rows.nth(0).getByTestId("bill-urgency")).toHaveText("Overdue by 4 days");
    await expect(rows.nth(1).getByTestId("bill-urgency")).toHaveText("Due in 3 days");
    // Beyond the "due soon" window there is nothing urgent to say, so it just states the date.
    await expect(rows.nth(2).getByTestId("bill-urgency")).toHaveText(`Due ${isoDaysFromToday(40)}`);
    await expect(rows.nth(3).getByTestId("bill-urgency")).toHaveCount(0);

    // Overdue and due-today escalate to red; due-soon stays on the amber the page already uses for
    // "unpaid", rather than introducing a third colour that competes with the status pills.
    await expect(rows.nth(0).getByTestId("bill-urgency")).toHaveClass(/text-red-800/);
    await expect(rows.nth(1).getByTestId("bill-urgency")).toHaveClass(/text-amber-800/);

    await expect(rows.nth(0)).toContainText("$412.90");
    await expect(rows.nth(2)).toContainText("$14,900.00");
    await expect(page.getByTestId("unpaid-summary")).toContainText("$18,203.40");
  });

  test("does not say 'No bills yet' while also announcing detected bills", async ({ browser }) => {
    const { page, userId } = await createSignedInPage(browser, "empty");
    await seedBills(userId, [
      { vendor: "Orion Cloud Hosting", number: `OCH-${Date.now()}`, cents: 120499, due: isoDaysFromToday(2), status: "pending_review" },
    ]);

    await page.goto("/bills");
    await expect(page.getByTestId("pending-review-section")).toContainText("1 bill detected from email");
    // The two used to render together, which is how a user learns to distrust the whole page.
    await expect(page.getByTestId("no-bills")).toHaveCount(0);
  });

  test("keeps the review row's columns aligned when vendor names differ wildly in length", async ({ browser }) => {
    const { page, userId } = await createSignedInPage(browser, "align");
    await seedBills(userId, [
      {
        vendor: "Brightwater Facilities Management & Commercial Cleaning Services Ltd",
        number: `BFM-${Date.now()}`,
        cents: 345075,
        due: isoDaysFromToday(6),
        status: "pending_review",
      },
      { vendor: "Delta Legal", number: `DL-${Date.now()}`, cents: 89000, due: isoDaysFromToday(12), status: "pending_review" },
    ]);

    await page.goto("/bills");
    const rows = page.getByTestId("pending-review-row");
    await expect(rows).toHaveCount(2);

    // The bug: a long vendor name widened its own column (a bare `2fr` track floors at min-content),
    // shoving Due and Amount right on that row only, so no two rows lined up. Asserting on real
    // geometry rather than on classes, because the classes were never the thing that looked wrong.
    const box = async (i: number, id: string) => (await rows.nth(i).getByTestId(id).boundingBox())!;
    const due0 = await box(0, "pending-review-due-date");
    const due1 = await box(1, "pending-review-due-date");
    const amt0 = await box(0, "pending-review-amount");
    const amt1 = await box(1, "pending-review-amount");
    const rem0 = await box(0, "pending-review-reminder");
    const rem1 = await box(1, "pending-review-reminder");

    expect(Math.abs(due0.x - due1.x)).toBeLessThan(2);
    expect(Math.abs(amt0.x - amt1.x)).toBeLessThan(2);
    expect(Math.abs(rem0.x - rem1.x)).toBeLessThan(2);

    // And the long name is truncated to one line instead of wrapping the row taller.
    const vendor0 = (await rows.nth(0).locator("p").first().boundingBox())!;
    expect(vendor0.height).toBeLessThan(due0.height * 2);
  });
});

test.describe("a bill's reminder after approval", () => {
  test("is visible on the detail page and can be edited there", async ({ browser }) => {
    const { page, userId } = await createSignedInPage(browser, "reminder");
    const [bill] = await seedBills(userId, [
      {
        vendor: "Meridian Insurance",
        number: `MI-${Date.now()}`,
        cents: 284050,
        due: isoDaysFromToday(3),
        status: "unpaid",
        reminderValue: 2,
        reminderUnit: "hours",
      },
    ]);

    await page.goto(`/bills/${bill.id}`);
    // Before this existed, an approved bill's reminder was invisible everywhere.
    await expect(page.getByTestId("bill-reminder-summary")).toHaveText("2 hours before due");

    await page.getByTestId("edit-bill-reminder").click();
    await page.getByTestId("pending-review-reminder-value").fill("30");
    await page.getByTestId("pending-review-reminder-unit").selectOption("minutes");
    await page.getByTestId("save-bill-reminder").click();

    await expect(page.getByTestId("bill-reminder-summary")).toHaveText("30 minutes before due");
    await page.reload();
    await expect(page.getByTestId("bill-reminder-summary")).toHaveText("30 minutes before due");
  });

  test("rejects an absurd year with a message that names the real problem", async ({ browser }) => {
    const { page, userId } = await createSignedInPage(browser, "bounds");
    const [bill] = await seedBills(userId, [
      { vendor: "Delta Legal", number: `DL-${Date.now()}`, cents: 89000, due: isoDaysFromToday(12), status: "unpaid" },
    ]);

    await page.goto(`/bills/${bill.id}`);
    await page.getByTestId("edit-bill-reminder").click();
    await page.getByTestId("reminder-mode-exact").click();

    // What a real tester actually managed to type into the year field.
    await page.getByTestId("pending-review-reminder-at").fill("100120-10-05T14:00");
    await page.getByTestId("save-bill-reminder").click();

    const error = page.getByTestId("bill-reminder-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText("100120");
    // The old message claimed nothing had been picked, when something had been.
    await expect(error).not.toContainText("Pick a date and time for the reminder");
  });
});

test.describe("in-app notifications", () => {
  test("shows real rows, counts unread on the bell, and marks them read", async ({ browser }) => {
    const { page, userId } = await createSignedInPage(browser, "notif");
    const [bill] = await seedBills(userId, [
      { vendor: "Kestrel Property Mgmt", number: `KPM-${Date.now()}`, cents: 1490000, due: isoDaysFromToday(40), status: "unpaid" },
    ]);
    await rest("POST", "notifications", [
      {
        user_id: userId,
        type: "bill_reminder",
        title: "Bill due soon",
        body: `Kestrel Property Mgmt: $14,900.00 due ${isoDaysFromToday(40)}.`,
        related_bill_id: bill.id,
      },
      { user_id: userId, type: "bill_detected", title: "New bill detected", body: "Delta Legal: $890.00 due soon.", related_bill_id: null },
    ]);

    // The bell is the entry point the channel never had; the badge is what makes it worth looking at.
    await page.goto("/bills");
    await expect(page.getByTestId("notification-badge")).toHaveText("2");

    await page.getByTestId("notification-bell").click();
    await page.waitForURL("**/notifications");
    await expect(page.getByTestId("notification-row")).toHaveCount(2);

    // Addressed by its content, not its index: which of two same-instant rows sorts first is not
    // what this test is about, and pinning it to a position made the test assert the wrong row.
    const reminderRow = page.getByTestId("notification-row").filter({ hasText: "Bill due soon" });
    await expect(reminderRow).toContainText("$14,900.00");
    await expect(reminderRow).toHaveAttribute("data-read", "false");

    // The row flips optimistically, so waiting on the UI alone would prove nothing about the write.
    // Waiting for the PATCH itself is also what stops the reload below from racing it: a reload
    // fired mid-flight cancels the request and the test would fail for a reason the product doesn't
    // have.
    const patched = page.waitForResponse(
      (r) => r.url().includes("/rest/v1/notifications") && r.request().method() === "PATCH",
    );
    await reminderRow.getByTestId("mark-one-read").click();
    expect((await patched).status()).toBeLessThan(300);
    await expect(reminderRow).toHaveAttribute("data-read", "true");
    await expect(page.getByTestId("mark-all-read")).toContainText("(1)");

    const persisted = (await rest("GET", `notifications?user_id=eq.${userId}&select=title,read_at`)) as {
      title: string;
      read_at: string | null;
    }[];
    expect(persisted.find((n) => n.title === "Bill due soon")!.read_at).not.toBeNull();
    expect(persisted.find((n) => n.title === "New bill detected")!.read_at).toBeNull();

    // Survives a round trip to the database, not just optimistic local state.
    await page.reload();
    await expect(page.getByTestId("notification-row").filter({ hasText: "Bill due soon" })).toHaveAttribute(
      "data-read",
      "true",
    );

    const allPatched = page.waitForResponse(
      (r) => r.url().includes("/rest/v1/notifications") && r.request().method() === "PATCH",
    );
    await page.getByTestId("mark-all-read").click();
    expect((await allPatched).status()).toBeLessThan(300);
    await expect(page.getByTestId("mark-all-read")).toHaveCount(0);
    await page.goto("/bills");
    await expect(page.getByTestId("notification-badge")).toHaveCount(0);
  });

  test("says so plainly when there is nothing to show", async ({ browser }) => {
    const { page } = await createSignedInPage(browser, "notif-empty");
    await page.goto("/notifications");
    await expect(page.getByTestId("no-notifications")).toBeVisible();
  });
});

test.describe("review queue", () => {
  test("saves a reminder edit as it is made, so a re-render cannot silently lose it", async ({ browser }) => {
    const { page, userId } = await createSignedInPage(browser, "autosave");
    const [bill] = await seedBills(userId, [
      { vendor: "Orion Cloud Hosting", number: `OCH-${Date.now()}`, cents: 120499, due: isoDaysFromToday(9), status: "pending_review" },
    ]);

    await page.goto("/bills");
    await page.getByTestId("pending-review-reminder-unit").selectOption("hours");
    await expect(page.getByTestId("reminder-save-state")).toHaveText("Saved");

    // The reported symptom was the edit reverting on the next render. Reloading is a strictly
    // harsher version of that: it throws away every scrap of component state.
    await page.reload();
    await expect(page.getByTestId("pending-review-reminder-unit")).toHaveValue("hours");

    const stored = await rest("GET", `bills?id=eq.${bill.id}&select=reminder_offset_unit`);
    expect(stored[0].reminder_offset_unit).toBe("hours");
  });

  test("flags a duplicate rather than leaving two indistinguishable rows", async ({ browser }) => {
    const { page, userId } = await createSignedInPage(browser, "dupe");
    const due = isoDaysFromToday(20);
    const [first] = await seedBills(userId, [
      { vendor: "Clayworks Wholesale", number: `CW-${Date.now()}`, cents: 124860, due, status: "pending_review" },
    ]);
    const [second] = await seedBills(userId, [
      { vendor: "Clayworks Wholesale", number: `CW-${Date.now()}-2`, cents: 124860, due, status: "pending_review" },
    ]);
    await rest("PATCH", `bills?id=eq.${second.id}`, { duplicate_of_bill_id: first.id });

    await page.goto("/bills");
    const flag = page.getByTestId("duplicate-bill-flag");
    await expect(flag).toHaveCount(1);
    await expect(flag).toContainText(first.bill_number);
  });
});
