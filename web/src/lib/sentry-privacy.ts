import type { ErrorEvent, EventHint, Log } from "@sentry/nextjs"
import { metricNames, type MetricName } from "./telemetry-schema"

const errorTypes = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError"])
const safeIntegrations = new Set([
  "InboundFilters", "EventFilters", "FunctionToString", "BrowserApiErrors", "GlobalHandlers",
  "LinkedErrors", "Dedupe", "OnUncaughtException", "OnUnhandledRejection",
  "NextjsClientStackFrameNormalization", "DistDirRewriteFrames",
])
export const failureMetrics = new Set<MetricName>([
  "room_error", "stream_error", "speech_error", "pwa_error", "dictation_error",
  "dictation_connect_timeout", "dictation_finalize_timeout", "dictation_disconnect",
])

/** Only bundled code locations survive. Never send local paths or URL queries. */
function codeFile(value?: string) {
  return value?.split(/[?#]/, 1)[0].match(/(?:app:\/\/\/|\/)?(?:_next\/(?:static|server)|\.next\/server)\/[\w./[\]-]+\.js$/)?.[0]
}

function metricName(value: unknown): MetricName | undefined {
  return typeof value === "string" && metricNames.includes(value as MetricName) ? value as MetricName : undefined
}

/** Reconstruct instead of deleting keys: new SDK fields are private by default. */
export function sanitizeError(event: ErrorEvent): ErrorEvent {
  const metric = metricName(event.tags?.["room.metric"])
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: event.level,
    platform: event.platform,
    release: event.release,
    environment: event.environment,
    ...(metric ? { message: `room.${metric}`, fingerprint: ["room", metric], tags: { "room.metric": metric } } : {}),
    exception: event.exception ? { values: event.exception.values?.map((exception) => ({
      type: errorTypes.has(exception.type ?? "") ? exception.type : "Error",
      value: "Application error (details removed for privacy)",
      mechanism: exception.mechanism ? { type: "generic", handled: exception.mechanism.handled } : undefined,
      stacktrace: { frames: exception.stacktrace?.frames?.flatMap((frame) => {
        const filename = codeFile(frame.filename)
        return filename ? [{ filename, lineno: frame.lineno, colno: frame.colno, in_app: frame.in_app }] : []
      }) },
    })) } : undefined,
    debug_meta: event.debug_meta ? { images: event.debug_meta.images?.flatMap((entry) => {
      const code_file = codeFile(entry.code_file)
      return code_file && entry.debug_id && /^[\da-f-]{36}$/i.test(entry.debug_id)
        ? [{ type: "sourcemap", code_file, debug_id: entry.debug_id }] : []
    }) } : undefined,
  }
}

/** Only the app's numeric performance records may reach Sentry Logs. */
export function sanitizeLog(log: Log): Log | null {
  const name = metricName(log.attributes?.name)
  const value = log.attributes?.value
  if (log.message !== "room.performance" || !name || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 86_400_000) return null
  return { message: "room.performance", level: failureMetrics.has(name) ? "error" : "info", attributes: { name, value } }
}

export const sentryPrivacy = {
  dataCollection: {
    userInfo: false, cookies: false, httpHeaders: { request: false, response: false },
    httpBodies: [], urlQueryParams: false, genAI: { inputs: false, outputs: false },
    stackFrameVariables: false, frameContextLines: 0,
  },
  // Automatic tracing/DOM/console capture can contain spoken text and URLs.
  // Smoothness is measured by the existing bounded numeric telemetry instead.
  tracesSampleRate: 0,
  tracePropagationTargets: [],
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  autoSessionTracking: false,
  sendClientReports: false,
  maxBreadcrumbs: 0,
  enableLogs: true,
  integrations: <T extends { name: string }>(integrations: T[]) => integrations.filter(({ name }) => safeIntegrations.has(name)),
  beforeBreadcrumb: () => null,
  beforeSend: (event: ErrorEvent, hint: EventHint) => {
    hint.attachments = []
    return sanitizeError(event)
  },
  beforeSendTransaction: () => null,
  beforeSendLog: sanitizeLog,
}
