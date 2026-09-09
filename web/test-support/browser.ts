// Tests live in the repository test tree; resolve the browser runner from web's dependencies.
import { test as base } from "@playwright/test"
export { expect, type Page, type WebSocketRoute } from "@playwright/test"
import Axe from "@axe-core/playwright"

/**
 * A spoken line, as the room emits one.
 *
 * The grant is what `/api/speak` checks before it will read anything aloud, so
 * a mocked round has to carry one or the client discards the reply. Its value
 * is never verified here — these tests mock the synthesis route too — but its
 * PRESENCE is part of the contract this client is being tested against.
 */
export function said(agent: string, text: string, audio: string | null = null) {
  return { type: "said" as const, agent, text, audio, grant: "browser-test-grant" }
}

/** The room ships user-scalable=no: it is a fixed surface, and Safari's browser
 * tab ignores the flag anyway (see layout.tsx). axe's meta-viewport rule reports
 * that as a violation, so it is excluded once here. Every other rule still runs. */
export class AxeBuilder extends Axe {
  constructor(options: ConstructorParameters<typeof Axe>[0]) {
    super(options)
    this.disableRules(["meta-viewport"])
  }
}

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
