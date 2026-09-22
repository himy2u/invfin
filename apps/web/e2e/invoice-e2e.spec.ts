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

test("magic link sign-in, create invoice with client requiring email/phone", async ({ page }) => {
  const consoleLogs: string[] = [];
  page.on("console", (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));

  const email = `test-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  await page.getByTestId("create-invoice-tile").click();
  await page.waitForURL("**/invoices/new");

  await page.locator('[data-testid="new-client-name"]').fill("Acme Corp");
  await page.locator('input[placeholder="Client email (or phone below)"]').fill("acme@example.com");
  await page.locator('input[placeholder="Description"]').fill("Design work");
  await page.locator('input[placeholder="Rate"]').fill("500");
  await page.getByTestId("invoice-tax-rate").fill("10");

  await page.getByRole("button", { name: "Create invoice" }).click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  await expect(page.getByTestId("invoice-row")).toBeVisible();
  await expect(page.getByTestId("invoice-row")).toContainText("Acme Corp");
  await expect(page.getByTestId("invoice-row")).toContainText("550.00");

  await page.screenshot({ path: "/tmp/invfin-invoice-created.png", fullPage: true });

  console.log("CONSOLE_LOGS_START");
  for (const line of consoleLogs) console.log(line);
  console.log("CONSOLE_LOGS_END");
});
