import { test, expect } from "@playwright/test";

async function getMagicLink(email: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`http://127.0.0.1:54324/api/v1/search?query=to:${email}`);
    const data = await res.json();
    if (data.messages?.length > 0) {
      const msgRes = await fetch(`http://127.0.0.1:54324/api/v1/message/${data.messages[0].ID}`);
      const msg = await msgRes.json();
      const match = msg.Text.match(/\(\s*(http:\/\/[^\s)]+\/auth\/v1\/verify\?[^\s)]+)\s*\)/);
      if (match) return match[1];
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("magic link email never arrived");
}

test("business profile (Bill From) and named tax (HST) both flow through to the invoice", async ({ page }) => {
  test.setTimeout(30000);
  const email = `test-tax-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();
  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  // Set business profile (Bill From)
  await page.getByTestId("settings-link").click();
  await page.waitForURL("**/settings");
  await page.getByTestId("business-name-input").fill("14143001 Canada Inc");
  await page.getByTestId("business-address-input").fill("21 Iceboat Terr\nToronto, ON M5V 4A9");
  await page.getByTestId("tax-registration-input").fill("123456789RT0001");
  await page.getByTestId("save-profile-button").click();
  await expect(page.getByTestId("profile-saved")).toBeVisible();

  // Create an invoice with HST 13%, matching a real Canadian consulting invoice
  await page.goto("/invoices/new");
  await page.locator('[data-testid="new-client-name"]').fill("Zortech Solutions Inc.");
  await page.locator('[data-testid="new-client-email"]').fill("zortech@example.com");
  await page.locator('[data-testid="new-client-address"]').fill("Suite 303 - 996 Martin Grove Rd\nEtobicoke, ON M9W 4V8");

  const row = page.getByTestId("line-item-row").first();
  await row.locator('input[placeholder="Description"]').fill("Consulting hours");
  await row.locator('input[placeholder="Qty"]').fill("30");
  await row.locator('input[placeholder="Rate"]').fill("77");
  // 30 x 77 = 2310.00
  await expect(row.getByTestId("line-item-amount")).toHaveText("2310.00");

  // Tax is invoice-level now — one HST rate/name applied to the whole invoice, not per line.
  await page.getByTestId("invoice-tax-label").fill("HST");
  await page.getByTestId("invoice-tax-rate").fill("13");

  await page.getByTestId("submit-invoice-button").click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  await page.getByTestId("invoice-row").first().click();
  await page.waitForSelector('[data-testid="invoice-detail"]', { timeout: 10000 });

  await expect(page.getByTestId("bill-from")).toContainText("14143001 Canada Inc");
  await expect(page.getByTestId("bill-from")).toContainText("Toronto, ON");
  await expect(page.getByTestId("bill-from")).toContainText("123456789RT0001");
  await expect(page.getByTestId("bill-to")).toContainText("Zortech Solutions Inc.");
  await expect(page.getByTestId("detail-line-item").first()).toContainText("HST 13%");
  // 2310 x 13% = 300.30 tax, total = 2610.30
  await expect(page.getByTestId("detail-total")).toContainText("2610.30");
});
