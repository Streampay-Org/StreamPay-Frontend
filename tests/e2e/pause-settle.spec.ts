import { expect, test } from "@playwright/test";
import { seedActiveStream } from "./helpers/seed";

test("pauses and settles a seeded stream from its detail page", async ({ page, request }) => {
  const streamId = await seedActiveStream(request);
  await page.goto(`/streams/${streamId}`);

  await expect(page.getByLabel("Stream status: Active")).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByLabel("Stream status: Paused")).toBeVisible();

  await page.getByRole("button", { name: "Settle Stream" }).click();
  await expect(page.getByLabel("Stream status: Ended")).toBeVisible();
  await expect(page.getByRole("link", { name: "Print Stream Receipt" })).toHaveAttribute(
    "href",
    `/streams/${streamId}/receipt`,
  );
});
