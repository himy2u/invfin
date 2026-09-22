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

test("new user's business info prefills from a scanned document and saves on create", async ({ page }) => {
  test.setTimeout(90000);
  const email = `bizprofile-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  await page.goto("/invoices/new");
  // Brand-new user, no business profile yet — the editable "Your business info" block must show.
  await expect(page.getByTestId("business-name-input")).toBeVisible();

  await page.getByTestId("scan-file-input").setInputFiles("tests/fixtures/timesheet.csv");
  await expect(page.getByTestId("scan-notice")).toBeVisible({ timeout: 75000 });

  // The CSV's vendor is "14143001 Canada Inc" at "21 Iceboat Terr, Toronto, ON M5V 4A9".
  await expect(page.getByTestId("business-name-input")).toHaveValue(/14143001 Canada Inc/);
  await expect(page.getByTestId("business-address-input")).toHaveValue(/Toronto/);

  await page.locator('[data-testid="new-client-email"]').fill("ap@zortech.example");
  await page.getByTestId("submit-invoice-button").click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  await page.getByTestId("invoice-row").first().click();
  await page.waitForSelector('[data-testid="invoice-detail"]');
  await expect(page.getByTestId("bill-from")).toContainText("14143001 Canada Inc");
  await expect(page.getByTestId("bill-from")).toContainText("Toronto");
});
