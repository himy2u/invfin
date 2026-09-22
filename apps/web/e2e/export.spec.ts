import { test, expect } from "@playwright/test";
import fs from "node:fs";

async function getMagicLink(email: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`http://127.0.0.1:54324/api/v1/search?query=to:${email}`);
    const data = await res.json();
    if (data.messages?.length > 0) {
      const msgRes = await fetch(`http://127.0.0.1:54324/api/v1/message/${data.messages[0].ID}`);
      const msg = await msgRes.json();
      const match = msg.Text.match(/\(\s*(http:\/\/[^\s)]+\/auth\/v1\/verify\?[^\s)]+)\s*\)/);
      if (match) return match[1];
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("magic link email never arrived");
}

test("download PDF and CSV, and sending attaches a real PDF to the email", async ({ page }) => {
  test.setTimeout(30000);
  const email = `test-export-${Date.now()}@example.com`;
  const clientEmail = `export-client-${Date.now()}@example.com`;

  await page.goto("/login");
  await page.getByPlaceholder("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByTestId("magic-link-sent")).toBeVisible();
  const magicLink = await getMagicLink(email);
  await page.goto(magicLink);
  await page.waitForURL("**/dashboard", { timeout: 10000 });
  await page.goto("/invoices");

  await page.goto("/invoices/new");
  await page.locator('[data-testid="new-client-name"]').fill("Export Test Co");
  await page.locator('[data-testid="new-client-email"]').fill(clientEmail);
  const row = page.getByTestId("line-item-row").first();
  await row.locator('input[placeholder="Description"]').fill("Design");
  await row.locator('input[placeholder="Rate"]').fill("200");
  await page.getByTestId("submit-invoice-button").click();
  await page.waitForURL("**/invoices", { timeout: 10000 });

  await page.getByTestId("invoice-row").first().click();
  await page.waitForSelector('[data-testid="invoice-detail"]', { timeout: 10000 });

  const [pdfDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("download-pdf-button").click(),
  ]);
  const pdfPath = await pdfDownload.path();
  expect(pdfPath).toBeTruthy();
  const pdfBytes = fs.readFileSync(pdfPath!);
  expect(pdfBytes.subarray(0, 4).toString()).toBe("%PDF");
  console.log("PDF downloaded, size:", pdfBytes.length);

  const [csvDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("download-csv-button").click(),
  ]);
  const csvPath = await csvDownload.path();
  const csvText = fs.readFileSync(csvPath!, "utf-8");
  expect(csvText).toContain("Export Test Co");
  expect(csvText).toContain("Design");
  console.log("CSV downloaded, content includes client and line item");

  await page.getByTestId("send-invoice-button").click();
  await expect(page.getByTestId("send-confirmation")).toBeVisible({ timeout: 10000 });

  // Verify the actual email has a real PDF attachment, not just that the send call succeeded
  let messageId: string | null = null;
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`http://127.0.0.1:8026/api/v1/search?query=to:${clientEmail}`);
    const data = await res.json();
    if (data.messages?.length > 0) {
      messageId = data.messages[0].ID;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(messageId).toBeTruthy();
  const msgRes = await fetch(`http://127.0.0.1:8026/api/v1/message/${messageId}`);
  const msg = await msgRes.json();
  expect(msg.Attachments.length).toBeGreaterThan(0);
  expect(msg.Attachments[0].FileName).toMatch(/\.pdf$/);
  console.log("email attachment:", msg.Attachments[0].FileName);
});
