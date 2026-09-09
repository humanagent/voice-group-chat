import { startTelemetry } from "@/lib/telemetry"
import { startSentry } from "@/lib/sentry-client"

startTelemetry()
try { startSentry() } catch { /* Monitoring must not prevent hydration. */ }
