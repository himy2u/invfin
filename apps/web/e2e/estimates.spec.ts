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

test("create an estimate with a deposit and valid-until date, then convert it to an invoice", async ({ page }) => {
  // Converting is a one-way action and now confirms via window.confirm() before firing.
  page.on("dialog", (dialog) => dialog.accept());

  const email = `estimate-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  await page.getByTestId("estimates-link").click();
  await page.waitForURL("**/estimates");
  await expect(page.getByTestId("no-estimates")).toBeVisible();

  await page.getByTestId("create-estimate-button").click();
  await page.waitForURL("**/estimates/new");

  await page.locator('[data-testid="new-client-name"]').fill("Riverside Cafe");
  await page.locator('input[placeholder="Client email (or phone below)"]').fill("owner@riverside.example");
  await page.locator('input[placeholder="Description"]').fill("Kitchen remodel");
  await page.locator('input[placeholder="Rate"]').fill("5000");

  await page.getByTestId("valid-until-input").fill("2026-12-31");
  await page.getByTestId("deposit-input").fill("1000");
  await page.getByTestId("estimate-title-input").fill("Remodel Estimate");

  await page.getByTestId("submit-estimate-button").click();
  await page.waitForURL("**/estimates/*", { timeout: 10000 });

  await expect(page.getByRole("heading", { name: "Remodel Estimate" })).toBeVisible();
  await expect(page.getByTestId("estimate-status")).toContainText("draft");
  await expect(page.getByTestId("estimate-total")).toContainText("5000.00");

  await page.getByTestId("convert-to-invoice-button").click();
  await page.waitForURL("**/invoices/*", { timeout: 10000 });
  await expect(page.getByTestId("detail-total")).toContainText("5000.00");

  // Going back to the estimate now shows it as converted, with a link to the new invoice.
  await page.goto("/estimates");
  await page.getByTestId("estimate-row").first().click();
  await page.waitForURL("**/estimates/*");
  await expect(page.getByTestId("estimate-status")).toContainText("converted");
  await expect(page.getByTestId("view-converted-invoice")).toBeVisible();
});
