import { test, expect } from "@playwright/test";

const MAILPIT_URL = "http://127.0.0.1:54324";

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

test("editing a draft invoice updates its total and records a version in edit history", async ({ page }) => {
  const email = `edit-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  await page.getByTestId("create-invoice-tile").click();
  await page.waitForURL("**/invoices/new");
  await page.locator('[data-testid="new-client-name"]').fill("Fixit Co");
  await page.locator('input[placeholder="Client email (or phone below)"]').fill("ap@fixit.example");
  await page.locator('input[placeholder="Description"]').fill("Consulting");
  await page.locator('input[placeholder="Rate"]').fill("100");
  await page.getByRole("button", { name: "Create invoice" }).click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  await page.getByTestId("invoice-row").first().click();
  await page.waitForURL("**/invoices/*");
  await expect(page.getByTestId("detail-total")).toContainText("100.00");

  await page.getByTestId("edit-invoice-link").click();
  await page.waitForURL("**/invoices/*/edit");

  // Fix a typo'd rate and add a PO number — this is the exact class of correction that had no fix
  // path before: created invoices could only be viewed, exported, or sent.
  await page.locator('input[placeholder="Rate"]').first().fill("250");
  await page.getByTestId("po-number-input").fill("PO-777");
  await page.getByTestId("save-invoice-edit-button").click();

  await page.waitForURL("**/invoices/*", { timeout: 10000 });
  await expect(page.getByTestId("detail-total")).toContainText("250.00");
  await expect(page.getByTestId("invoice-po-number")).toContainText("PO-777");

  // The pre-edit state (100.00, the original total) must be recoverable from history, not
  // silently overwritten.
  await expect(page.getByTestId("edit-history-entry")).toContainText("Version 1");
  await expect(page.getByTestId("edit-history-entry")).toContainText("100.00");
});
