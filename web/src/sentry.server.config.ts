import * as Sentry from "@sentry/nextjs"
import { sentryPrivacy } from "./lib/sentry-privacy"

Sentry.init({
  ...sentryPrivacy,
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  skipOpenTelemetrySetup: true,
})
