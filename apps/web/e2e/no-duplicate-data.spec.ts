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

test("creating two invoices for the same typed client name reuses one client, not two", async ({ page }) => {
  const email = `dedup-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  // First invoice — creates "Dedup Client".
  await page.goto("/invoices/new");
  await page.locator('[data-testid="new-client-name"]').fill("Dedup Client");
  await page.locator('input[placeholder="Client email (or phone below)"]').fill("dedup@example.com");
  await page.locator('input[placeholder="Description"]').fill("First job");
  await page.locator('input[placeholder="Rate"]').fill("100");
  await page.getByTestId("submit-invoice-button").click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  // Second invoice — types the SAME client name again (not selecting the autocomplete suggestion)
  // instead of picking the saved client. This must reuse the existing client, not create a
  // second "Dedup Client" row.
  await page.goto("/invoices/new");
  await page.locator('[data-testid="new-client-name"]').fill("Dedup Client");
  await page.locator('input[placeholder="Client email (or phone below)"]').fill("dedup@example.com");
  await page.locator('input[placeholder="Description"]').fill("Second job");
  await page.locator('input[placeholder="Rate"]').fill("200");
  await page.getByTestId("submit-invoice-button").click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  await page.goto("/clients");
  const rows = page.getByTestId("client-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Dedup Client");
});

test("adding a product with a name that already exists in the catalog is rejected", async ({ page }) => {
  const email = `dedup-product-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  await page.goto("/settings/products");
  await page.getByTestId("product-name-input").fill("Consulting Hour");
  await page.getByTestId("add-product-button").click();
  await expect(page.getByTestId("product-row")).toHaveCount(1);

  // Same name again (different case) — must be rejected, not inserted as a second row.
  await page.getByTestId("product-name-input").fill("consulting hour");
  await page.getByTestId("add-product-button").click();
  await expect(page.getByText(/already in your catalog/)).toBeVisible();
  await expect(page.getByTestId("product-row")).toHaveCount(1);
});
