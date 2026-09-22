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

test("scanning a photo actually creates an invoice (not just a preview)", async ({ page }) => {
  test.setTimeout(90000);
  const email = `test-scan-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();

  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  await page.goto("/invoices/new");
  await page.getByTestId("scan-file-input").setInputFiles("tests/fixtures/sample-invoice.png");

  // Generous timeout: the agent retries Gemini's transient 503s with exponential backoff.
  await expect(page.getByTestId("scan-notice")).toBeVisible({ timeout: 75000 });

  // Scan can't read a client's contact info — this is the exact gap that was reported: scanning
  // alone must NOT be enough to submit, so this fills the required field manually before submit.
  await page.locator('[data-testid="new-client-email"]').fill("acme@example.com");

  await page.getByTestId("submit-invoice-button").click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  await expect(page.getByTestId("invoice-row")).toBeVisible();
  await expect(page.getByTestId("invoice-row")).toContainText("Acme Corp");
  await expect(page.getByTestId("invoice-row")).toContainText("1350.00");

  await page.screenshot({ path: "/tmp/invfin-scan-result.png", fullPage: true });
});
