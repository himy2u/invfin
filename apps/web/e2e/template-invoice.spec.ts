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

test("billing address, computed amount column, and reuse-as-template all work", async ({ page }) => {
  test.setTimeout(30000);
  const email = `test-template-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();
  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  // First invoice: new client with a billing address, two line items
  await page.goto("/invoices/new");
  await page.locator('[data-testid="new-client-name"]').fill("Template Co");
  await page.locator('[data-testid="new-client-email"]').fill("templateco@example.com");
  await page.locator('[data-testid="new-client-address"]').fill("123 Main St\nSpringfield, IL 62701");

  const rows = page.getByTestId("line-item-row");
  await rows.nth(0).locator('input[placeholder="Description"]').fill("Consulting hours");
  await rows.nth(0).locator('input[placeholder="Qty"]').fill("4");
  await rows.nth(0).locator('input[placeholder="Rate"]').fill("75");
  // Amount column should compute live: 4 x 75 = 300.00
  await expect(rows.nth(0).getByTestId("line-item-amount")).toHaveText("300.00");

  await page.getByTestId("submit-invoice-button").click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  // Detail page shows the address and a computed Amount column
  await page.getByTestId("invoice-row").first().click();
  await page.waitForSelector('[data-testid="invoice-detail"]', { timeout: 10000 });
  await expect(page.getByTestId("client-address")).toContainText("123 Main St");
  await expect(page.getByTestId("detail-line-item").first()).toContainText("300.00");

  // Second invoice: use the first as a template
  await page.goto("/invoices/new");
  const optionText = await page
    .locator('[data-testid="template-select"] option')
    .filter({ hasText: "Template Co" })
    .first()
    .textContent();
  await page.locator('[data-testid="template-select"]').selectOption({ label: optionText! });
  await expect(page.getByTestId("template-notice")).toBeVisible();
  await expect(page.getByTestId("selected-client")).toContainText("Template Co");
  await expect(rows.nth(0).locator('input[placeholder="Description"]')).toHaveValue("Consulting hours");

  // Change quantity per the ask ("change the date and price or quantity when entering manually")
  await rows.nth(0).locator('input[placeholder="Qty"]').fill("6");
  await expect(rows.nth(0).getByTestId("line-item-amount")).toHaveText("450.00");

  await page.getByTestId("submit-invoice-button").click();
  await page.waitForURL("**/invoices", { timeout: 10000 });
  await expect(page.getByTestId("invoice-row").first()).toContainText("450.00");
});
