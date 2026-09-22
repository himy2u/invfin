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

test("scanning a real timesheet CSV uses period-total hours (not the daily rate) and fills the client's address", async ({
  page,
}) => {
  test.setTimeout(90000);
  const email = `test-csv-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  await page.goto("/invoices/new");
  await page.getByTestId("scan-file-input").setInputFiles("tests/fixtures/timesheet.csv");
  await expect(page.getByTestId("scan-notice")).toBeVisible({ timeout: 75000 });

  // The CSV prints both "Daily Hours" (7.50) and "Total Hours Billed" (22.50/37.50/22.50/0.00) per
  // week — the real regression this covers is the model billing the daily rate instead of the
  // period total, which would silently undercount the invoice by roughly a factor of 5.
  const qtyInputs = page.locator('input[placeholder="Qty"]');
  await expect(qtyInputs.first()).not.toHaveValue("7.5");
  const firstQty = await qtyInputs.first().inputValue();
  expect(["22.5", "37.5", "0"]).toContain(firstQty);

  // Client name and billing address are printed on the document ("Bill To: Zortech Solutions
  // Inc. ... Etobicoke, ON") — scanning should pull the address into the form, not just the name.
  await expect(page.locator('[data-testid="new-client-name"]')).toHaveValue(/Zortech/);
  await expect(page.locator('[data-testid="new-client-address"]')).toHaveValue(/Etobicoke/);

  await page.locator('[data-testid="new-client-email"]').fill("ap@zortech.example");
  await page.getByTestId("submit-invoice-button").click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  await expect(page.getByTestId("invoice-row")).toBeVisible();
  await expect(page.getByTestId("invoice-row")).toContainText("Zortech");
});
