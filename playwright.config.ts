import { defineConfig, devices } from "@playwright/test";
const origin = process.env.HYPER_TEST_ORIGIN ?? "http://127.0.0.1:5173";
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: origin, trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
        viewport: { width: 1504, height: 1045 },
      },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: origin,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
