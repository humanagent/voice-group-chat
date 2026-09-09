import { defineConfig, devices } from "@playwright/test"
import config from "./playwright.config"

// Generate and compare these baselines in the pinned Linux container, not macOS.
export default defineConfig({
  ...config,
  testMatch: "mobile.spec.ts",
  outputDir: "test-results/visual",
  snapshotPathTemplate: "{testDir}/snapshots/{testFilePath}/{arg}{ext}",
  projects: [{ name: "visual", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium", deviceScaleFactor: 1 } }],
  use: { ...config.use, baseURL: process.env.ROOM_TEST_URL || "http://localhost:3100" },
  webServer: process.env.ROOM_TEST_URL ? undefined : config.webServer,
  expect: { toHaveScreenshot: { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.002 } },
})
