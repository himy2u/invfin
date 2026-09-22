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

test("add a product to the catalog, then pull it into an invoice line item", async ({ page }) => {
  const email = `products-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  await page.goto("/settings/products");
  await page.getByTestId("product-name-input").fill("Website design");
  await page.getByTestId("product-description-input").fill("Full custom site");
  await page.getByTestId("product-price-input").fill("1200");
  await page.getByTestId("add-product-button").click();
  await expect(page.getByTestId("product-row")).toContainText("Website design");

  await page.goto("/invoices/new");
  await page.locator('[data-testid="new-client-name"]').fill("Catalog Client");
  await page.locator('input[placeholder="Client email (or phone below)"]').fill("catalog@example.com");

  await page.getByTestId("add-from-catalog-select").selectOption({ label: "Website design" });

  await expect(page.locator('input[placeholder="Description"]').first()).toHaveValue(
    "Website design: Full custom site",
  );
  await expect(page.locator('input[placeholder="Rate"]').first()).toHaveValue("1200");

  await page.getByRole("button", { name: "Create invoice" }).click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  await expect(page.getByTestId("invoice-row").first()).toContainText("1200.00");
});
