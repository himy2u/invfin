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

test("currency, PO number, title, and summary flow from form to invoice detail", async ({ page }) => {
  const email = `currency-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  await page.getByTestId("create-invoice-tile").click();
  await page.waitForURL("**/invoices/new");

  await page.locator('[data-testid="new-client-name"]').fill("Northwind Ltd");
  await page.locator('input[placeholder="Client email (or phone below)"]').fill("ap@northwind.example");
  await page.locator('input[placeholder="Description"]').fill("Consulting");
  await page.locator('input[placeholder="Rate"]').fill("1000");

  await page.getByTestId("currency-select").selectOption("CAD");
  await page.getByTestId("po-number-input").fill("PO-4471");
  await page.getByTestId("invoice-title-input").fill("Project Kickoff Invoice");
  await page.getByTestId("invoice-summary-input").fill("First milestone of the Q4 engagement.");

  await page.getByRole("button", { name: "Create invoice" }).click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  await page.getByTestId("invoice-row").first().click();
  await page.waitForURL("**/invoices/*");

  await expect(page.getByRole("heading", { name: "Project Kickoff Invoice" })).toBeVisible();
  await expect(page.getByTestId("invoice-po-number")).toContainText("PO-4471");
  await expect(page.getByTestId("invoice-summary")).toContainText("First milestone");
  await expect(page.getByTestId("detail-total")).toContainText("CAD");
});
