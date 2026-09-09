import { expect, it } from "vitest"
import * as Sentry from "../../web/test-support/sentry"
import { sentryPrivacy } from "../../web/src/lib/sentry-privacy"

it("the real server SDK emits a sanitized envelope without making a network request", async () => {
  const envelopes: string[] = []
  Sentry.init({
    ...sentryPrivacy, dsn: "https://public@sentry.invalid/1", skipOpenTelemetrySetup: true,
    transport: () => ({
      send: async (envelope: unknown) => { envelopes.push(JSON.stringify(envelope)); return { statusCode: 200 } },
      flush: async () => true,
    }),
  })
  try {
    Sentry.withScope((scope) => {
      scope.setUser({ email: "PRIVATE_EMAIL" })
      scope.setContext("request", { body: "PRIVATE_TRANSCRIPT", authorization: "PRIVATE_TOKEN" })
      Sentry.captureException(new TypeError("PRIVATE_ERROR"), { attachments: [{ filename: "PRIVATE_AUDIO.wav", data: "PRIVATE_AUDIO_DATA" }] })
    })
    await Sentry.flush(1000)
    expect(envelopes.join("\n")).toContain("Application error (details removed for privacy)")
    expect(envelopes.join("\n")).not.toContain("PRIVATE_")
    expect(envelopes.join("\n")).not.toContain('"attachment"')
  } finally { await Sentry.close(1000) }
})
