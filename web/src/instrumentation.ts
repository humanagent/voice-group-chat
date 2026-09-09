import type { Instrumentation } from "next"

export async function register() {
  if (!process.env.SENTRY_DSN && !process.env.NEXT_PUBLIC_SENTRY_DSN) return
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config")
}

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!process.env.SENTRY_DSN && !process.env.NEXT_PUBLIC_SENTRY_DSN) return
  const { captureRequestError } = await import("@sentry/nextjs")
  await captureRequestError(...args)
}
