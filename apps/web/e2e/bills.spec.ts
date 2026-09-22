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

test("create a bill (accounts payable) manually and mark it paid", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  const email = `bill-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  await page.getByTestId("bills-link").click();
  await page.waitForURL("**/bills");
  await expect(page.getByTestId("no-bills")).toBeVisible();

  await page.getByTestId("create-bill-button").click();
  await page.waitForURL("**/bills/new");

  await page.getByTestId("vendor-name-input").fill("Office Supplies Co");
  await page.locator('input[placeholder="Description"]').fill("Printer paper");
  await page.locator('input[placeholder="Rate"]').fill("45");
  await page.getByTestId("submit-bill-button").click();

  await page.waitForURL("**/bills", { timeout: 10000 });
  await expect(page.getByTestId("bill-row")).toContainText("Office Supplies Co");
  await expect(page.getByTestId("unpaid-summary")).toContainText("45.00");

  await page.getByTestId("bill-row").first().click();
  await page.waitForSelector('[data-testid="bill-detail"]');
  await expect(page.getByTestId("bill-status")).toContainText("unpaid");
  await expect(page.getByTestId("bill-total")).toContainText("45.00");

  await page.getByTestId("mark-bill-paid-button").click();
  await expect(page.getByTestId("bill-status")).toContainText("paid", { timeout: 10000 });
  await expect(page.getByTestId("mark-bill-paid-button")).not.toBeVisible();
});

test("scanning a vendor document pre-fills a bill", async ({ page }) => {
  test.setTimeout(90000);
  const email = `bill-scan-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  await page.goto("/bills/new");
  await page.getByTestId("bill-scan-file-input").setInputFiles("tests/fixtures/timesheet.csv");
  await expect(page.getByTestId("bill-scan-notice")).toBeVisible({ timeout: 75000 });

  await expect(page.getByTestId("vendor-name-input")).toHaveValue(/14143001 Canada Inc/);
  await expect(page.getByTestId("submit-bill-button")).toBeEnabled();
});
