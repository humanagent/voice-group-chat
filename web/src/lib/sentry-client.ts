import * as Sentry from "@sentry/nextjs"
import { failureMetrics, sentryPrivacy } from "./sentry-privacy"
import { subscribeBatches } from "./telemetry"

export function startSentry() {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return
  Sentry.init({
    ...sentryPrivacy,
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  })
  // Sample healthy visits for cost/overhead; always report handled failures.
  const sampled = Math.random() < 0.1
  const lastIssue = new Map<string, number>()
  subscribeBatches((samples) => {
    for (const { name, value } of samples) {
      const failure = failureMetrics.has(name)
      if (sampled || failure) Sentry.logger.info("room.performance", { name, value })
      // Runtime errors are captured by the SDK, not duplicated by their counter.
      if (failure && performance.now() - (lastIssue.get(name) ?? -Infinity) >= 60_000) {
        lastIssue.set(name, performance.now())
        Sentry.captureMessage(`room.${name}`, { level: "error", tags: { "room.metric": name } })
      }
    }
  })
}
