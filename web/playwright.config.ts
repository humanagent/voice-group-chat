import { defineConfig, devices } from "@playwright/test"

const fakeMicrophone = { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] }

export default defineConfig({
  testDir: "../tests/web/browser",
  outputDir: "test-results",
  fullyParallel: true,
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:3100", trace: "retain-on-failure", screenshot: "only-on-failure",
    // Service-worker routing is only supported by Playwright on Chromium.
    // Offline integration opts in separately; ordinary tests must keep mocks isolated.
    serviceWorkers: "block",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 }, launchOptions: fakeMicrophone } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium", launchOptions: fakeMicrophone } },
    // Synthetic microphone/WebSocket tests require Chromium's fake capture device.
    { name: "webkit", testIgnore: /dictation\.spec\.ts/, use: { ...devices["iPhone 13"] } },
    { name: "firefox", testIgnore: /dictation\.spec\.ts/, use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: {
    command: "pnpm start -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    env: {
      SENTRY_DSN: "",
      SENTRY_AUTH_TOKEN: "",
      NEXT_PUBLIC_SENTRY_DSN: "https://public@sentry.invalid/1",
      // Enables voice controls; every provider request is intercepted by the tests.
      ELEVENLABS_API_KEY: "browser-test-only",
      GROUP_AGENTS: JSON.stringify(["Anna", "Jordan", "Pepe"].map((name) => ({ name, url: "http://127.0.0.1:9", key: "browser-test-only" }))),
    },
  },
})
