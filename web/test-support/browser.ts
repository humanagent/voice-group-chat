// Tests live in the repository test tree; resolve the browser runner from web's dependencies.
import { test as base } from "@playwright/test"
export { expect, type Page, type WebSocketRoute } from "@playwright/test"
export { default as AxeBuilder } from "@axe-core/playwright"

// A test build uses a reserved .invalid DSN. Never send test data to a service.
export const test = base.extend<{ blockMonitoring: void }>({
  blockMonitoring: [async ({ context }, use) => {
    await context.route("https://sentry.invalid/**", (route) => route.fulfill({ json: {} }))
    await use()
  }, { auto: true }],
})
