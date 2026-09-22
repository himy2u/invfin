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

test("building an invoice through a multi-turn chat conversation", async ({ page }) => {
  test.setTimeout(150000);
  const email = `chatbuilder-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  await page.goto("/invoices/new");
  await page.getByTestId("open-chat-builder-button").click();
  await expect(page.getByTestId("chat-invoice-builder")).toBeVisible();

  await page.getByTestId("chat-input").fill("bill Riverside Cafe $2000 for the kitchen remodel");
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-assistant-message").first()).toBeVisible({ timeout: 45000 });
  await expect(page.getByTestId("chat-draft-preview")).toContainText("Riverside Cafe");
  await expect(page.getByTestId("use-chat-draft-button")).toBeVisible();

  // A second turn should ADD to the draft, not replace it — the client/line-item from turn one
  // must survive.
  await page.getByTestId("chat-input").fill("their email is owner@riverside.example");
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-assistant-message").nth(1)).toBeVisible({ timeout: 45000 });
  await expect(page.getByTestId("chat-draft-preview")).toContainText("Riverside Cafe");
  await expect(page.getByTestId("chat-draft-preview")).toContainText("remodel");

  await page.getByTestId("use-chat-draft-button").click();

  await expect(page.locator('[data-testid="new-client-name"]')).toHaveValue(/Riverside Cafe/);
  await expect(page.locator('[data-testid="new-client-email"]')).toHaveValue("owner@riverside.example");
  await expect(page.locator('input[placeholder="Rate"]').first()).toHaveValue("2000");

  await page.getByTestId("submit-invoice-button").click();
  await page.waitForURL("**/invoices", { timeout: 10000 });
  await expect(page.getByTestId("invoice-row")).toContainText("Riverside Cafe");
});
