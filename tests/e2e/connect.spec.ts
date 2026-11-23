import { expect, test } from "@playwright/test";

const TEST_WALLET = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

test("connects a mocked Freighter wallet and shows its shortened address", async ({ page }) => {
  await page.addInitScript((address) => {
    window.freighterApi = {
      getAddress: async () => ({ address }),
    };
  }, TEST_WALLET);

  await page.goto("/streams");
  await page.getByRole("button", { name: "Wallet status: disconnected" }).click();
  await expect(page.getByRole("dialog", { name: "Connect Wallet" })).toBeVisible();
  await page.getByRole("button", { name: /^Freighter/ }).click();

  await expect(page.getByTestId("wallet-badge")).toContainText("GDSB...FSQA");
});
