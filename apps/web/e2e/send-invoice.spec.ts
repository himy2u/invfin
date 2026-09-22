import { test, expect } from "@playwright/test";

const AUTH_MAILPIT = "http://127.0.0.1:54324";
const APP_MAILPIT = "http://127.0.0.1:8026";

async function getMagicLink(email: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${AUTH_MAILPIT}/api/v1/search?query=to:${email}`);
    const data = await res.json();
    if (data.messages?.length > 0) {
      const msgRes = await fetch(`${AUTH_MAILPIT}/api/v1/message/${data.messages[0].ID}`);
      const msg = await msgRes.json();
      const match = msg.Text.match(/\(\s*(http:\/\/[^\s)]+\/auth\/v1\/verify\?[^\s)]+)\s*\)/);
      if (match) return match[1];
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("magic link email never arrived");
}

test("open a created invoice, send it, client autocomplete reuses saved clients", async ({ page }) => {
  test.setTimeout(30000);
  const email = `test-send-${Date.now()}@example.com`;
  const clientEmail = `client-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();
  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  // First invoice: creates a new client
  await page.goto("/invoices/new");
  await page.locator('[data-testid="new-client-name"]').fill("Repeat Client");
  await page.locator('[data-testid="new-client-email"]').fill(clientEmail);
  await page.locator('input[placeholder="Description"]').fill("First job");
  await page.locator('input[placeholder="Rate"]').fill("100");
  await page.getByTestId("submit-invoice-button").click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  // Second invoice: typing the same name should suggest the saved client (autocomplete)
  await page.goto("/invoices/new");
  await page.locator('[data-testid="new-client-name"]').fill("Repeat");
  await expect(page.getByTestId("client-suggestions")).toBeVisible();
  await page.getByTestId("client-suggestion").first().click();
  await expect(page.getByTestId("selected-client")).toContainText("Repeat Client");
  await page.locator('input[placeholder="Description"]').fill("Second job");
  await page.locator('input[placeholder="Rate"]').fill("50");
  await page.getByTestId("submit-invoice-button").click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  // Open the invoice and send it for real
  await page.getByTestId("invoice-row").first().click();
  await page.waitForSelector('[data-testid="invoice-detail"]', { timeout: 10000 });
  await expect(page.getByTestId("detail-total")).toContainText("50.00");

  await page.getByTestId("send-invoice-button").click();
  await expect(page.getByTestId("send-confirmation")).toBeVisible({ timeout: 10000 });

  // Verify against the app's real Mailpit — not just trusting the UI's claim
  let found = false;
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${APP_MAILPIT}/api/v1/search?query=to:${clientEmail}`);
    const data = await res.json();
    if (data.messages?.length > 0) {
      found = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(found).toBe(true);

  await page.screenshot({ path: "/tmp/invfin-invoice-sent.png", fullPage: true });
});
