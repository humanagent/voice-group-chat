import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "../tests/web/browser",
  outputDir: "test-results",
  fullyParallel: true,
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:3100", trace: "retain-on-failure", screenshot: "only-on-failure",
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
  webServer: {
    command: "pnpm start -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    env: {
      // Enables voice controls; every provider request is intercepted by the tests.
      ELEVENLABS_API_KEY: "browser-test-only",
      GROUP_AGENTS: JSON.stringify(["Anna", "Jordan", "Pepe"].map((name) => ({ name, url: "http://127.0.0.1:9", key: "browser-test-only" }))),
    },
  },
})
