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

test("client detail page: edit account number, website, notes, and add a second contact", async ({ page }) => {
  const email = `clientdetail-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  // Create a client the normal way (via an invoice), then go edit it.
  await page.getByTestId("create-invoice-tile").click();
  await page.waitForURL("**/invoices/new");
  await page.locator('[data-testid="new-client-name"]').fill("Beacon Studio");
  await page.locator('input[placeholder="Client email (or phone below)"]').fill("hello@beacon.example");
  await page.locator('input[placeholder="Description"]').fill("Retainer");
  await page.locator('input[placeholder="Rate"]').fill("200");
  await page.getByRole("button", { name: "Create invoice" }).click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  await page.goto("/clients");
  await expect(page.getByTestId("client-row")).toContainText("Beacon Studio");
  await page.getByTestId("client-row").first().click();
  await page.waitForURL("**/clients/*");

  await page.getByTestId("client-account-number").fill("ACC-55");
  await page.getByTestId("client-website").fill("https://beacon.example");
  await page.getByTestId("client-private-notes").fill("Pays net-15, prefers email.");
  await page.getByTestId("add-contact-button").click();
  await page.locator('[data-testid="additional-contact-row"] input[placeholder="Name"]').fill("Jordan Lee");
  await page.locator('[data-testid="additional-contact-row"] input[placeholder="Email"]').fill("jordan@beacon.example");
  await page.getByTestId("client-default-currency").selectOption("EUR");

  await page.getByTestId("save-client-button").click();
  await expect(page.getByTestId("client-saved")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId("client-account-number")).toHaveValue("ACC-55");
  await expect(page.getByTestId("client-website")).toHaveValue("https://beacon.example");
  await expect(page.locator('[data-testid="additional-contact-row"] input[placeholder="Name"]')).toHaveValue(
    "Jordan Lee",
  );
  await expect(page.getByTestId("client-default-currency")).toHaveValue("EUR");
});
