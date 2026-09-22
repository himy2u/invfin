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

test("scanning a non-timesheet document offers to save its line items to the product catalog", async ({ page }) => {
  test.setTimeout(90000);
  const email = `autolearn-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  await page.goto("/invoices/new");
  await page.getByTestId("scan-file-input").setInputFiles("tests/fixtures/sample-invoice.png");
  await expect(page.getByTestId("scan-notice")).toBeVisible({ timeout: 75000 });

  // A non-timesheet scan (an invoice/receipt/PO) should offer to learn its line items.
  await expect(page.getByTestId("save-to-catalog-button")).toBeVisible();
  await page.getByTestId("save-to-catalog-button").click();
  await expect(page.getByTestId("catalog-saved-notice")).toBeVisible();

  await page.goto("/settings/products");
  await expect(page.getByTestId("product-row").first()).toBeVisible();
});
