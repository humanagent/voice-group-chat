// Tests live in the repository test tree; resolve the browser runner from web's dependencies.
import { test as base } from "@playwright/test"
export { expect, type Page, type WebSocketRoute } from "@playwright/test"
export { default as AxeBuilder } from "@axe-core/playwright"

// A test build uses a reserved .invalid DSN. Never send test data to a service.
export const test = base.extend<{ blockMonitoring: void }>({
  blockMonitoring: [async ({ context }, use) => {
    await context.route("https://sentry.invalid/**", (route) => route.fulfill({ json: {} }))
    // Score recovery is read on both entry URLs. Page-specific challenge mocks
    // override this; ordinary tests never see a real browser's saved result.
    await context.route("**/api/challenge", (route) => route.request().method() === "GET" ? route.fulfill({ json: { run: null } }) : route.abort())
    await context.route("**/api/scribe", (route) => route.fulfill({ status: 503, json: { error: "Microphone mocked; voice tests override this route" } }))
    await use()
  }, { auto: true }],
})
