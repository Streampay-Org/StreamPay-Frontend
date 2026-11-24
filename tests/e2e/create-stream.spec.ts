import { expect, test } from "@playwright/test";

const TEST_RECIPIENT = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

test("creates a stream through the wizard and lists it", async ({ page }) => {
  await page.goto("/streams/new");
  await page.getByLabel("Recipient address").fill(TEST_RECIPIENT);
  await page.getByLabel("Amount").fill("75");
  await page.getByLabel("Token").selectOption("XLM");
  await page.getByRole("button", { name: "Create Stream" }).click();

  await expect(page).toHaveURL(/\/streams\/stream-/);
  await expect(page.getByRole("heading", { name: "Payment Stream" })).toBeVisible();

  await page.goto("/streams");
  const createdRow = page.locator("article.stream-row").filter({ hasText: "75 XLM / month" });
  await expect(createdRow.getByRole("heading", { name: TEST_RECIPIENT })).toBeVisible();
});
