import { defineConfig, devices } from "@playwright/test";
const origin = process.env.HYPER_TEST_ORIGIN ?? "http://127.0.0.1:5173";
export default defineConfig({
  testDir: "tests/nextcloud",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 15000 },
  use: {
    baseURL: origin,
    ...devices["Desktop Chrome"],
    channel: "chromium",
    trace: "off",
    actionTimeout: Number(process.env.HYPER_SOURCE_ACTION_TIMEOUT ?? 15000),
    navigationTimeout: 30000,
  },
  webServer: {
    command: "npm run dev",
    url: origin,
    reuseExistingServer: false,
    timeout: 60000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
