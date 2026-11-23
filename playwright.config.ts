import { defineConfig, devices } from "@playwright/test";

const jwtSecret = "streampay-playwright-test-only-secret-not-for-production";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [["html", { outputFolder: "playwright-report", open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      JWT_SECRET: jwtSecret,
      AUDIT_CHAIN_KEY: "test-audit-chain-key-do-not-use-in-prod",
      ALLOWED_ORIGINS: "http://localhost:3000",
      STELLAR_NETWORK: "testnet",
    },
  },
});
