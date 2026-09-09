import { describe, expect, it } from "vitest"
import { sanitizeError, sanitizeLog, sentryPrivacy } from "../../web/src/lib/sentry-privacy"

describe("Sentry privacy boundary", () => {
  it("removes text, credentials, URLs, identities, and stack locals while keeping code coordinates", () => {
    const secret = "PRIVATE_TRANSCRIPT_OR_TOKEN"
    const result = sanitizeError({
      type: undefined, event_id: "a".repeat(32), level: "error", release: "test-release",
      message: secret, logentry: { message: secret }, request: { url: `/api/speak?text=${secret}`, data: secret, headers: { authorization: secret } },
      user: { email: secret, ip_address: secret }, extra: { audio: secret }, tags: { chat: secret },
      contexts: { arbitrary: { text: secret } }, breadcrumbs: [{ message: secret, data: { token: secret } }],
      exception: { values: [{ type: secret, value: secret, mechanism: { type: secret, handled: false, data: { secret } }, stacktrace: { frames: [
        { filename: `https://example.test/_next/static/chunks/abc.js?text=${secret}`, lineno: 3, colno: 5, vars: { secret }, function: secret, context_line: secret },
        { filename: `/Users/${secret}/project/source.ts`, function: secret },
      ] } }] },
      debug_meta: { images: [{ type: "sourcemap", code_file: `https://example.test/_next/static/chunks/abc.js?text=${secret}`, debug_id: "01234567-89ab-cdef-0123-456789abcdef" }] },
    })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(result.exception?.values?.[0].stacktrace?.frames).toEqual([{ filename: "/_next/static/chunks/abc.js", lineno: 3, colno: 5 }])
    expect(result.debug_meta?.images?.[0].code_file).toBe("/_next/static/chunks/abc.js")
    expect(result.release).toBe("test-release")
  })

  it("groups known operational failures without arbitrary message text", () => {
    expect(sanitizeError({ type: undefined, message: "private", tags: { "room.metric": "dictation_finalize_timeout", other: "private" } })).toMatchObject({
      message: "room.dictation_finalize_timeout", fingerprint: ["room", "dictation_finalize_timeout"], tags: { "room.metric": "dictation_finalize_timeout" },
    })
    expect(sanitizeError({ type: undefined, message: "private", tags: { "room.metric": "private" } }).message).toBeUndefined()
  })

  it("retains normalized Next server bundle coordinates for source-map resolution", () => {
    const filename = "app:///_next/server/chunks/ssr/abc.js"
    const result = sanitizeError({ type: undefined, exception: { values: [{ type: "TypeError", value: "private", stacktrace: { frames: [{ filename, lineno: 12, colno: 3 }] } }] } })
    expect(result.exception?.values?.[0].stacktrace?.frames?.[0]).toEqual({ filename, lineno: 12, colno: 3 })
  })

  it("accepts only bounded known numeric logs and reconstructs attributes", () => {
    expect(sanitizeLog({ level: "info", message: "room.performance", attributes: { name: "dictation_render", value: 16, text: "private", token: "private" } })).toEqual({
      level: "info", message: "room.performance", attributes: { name: "dictation_render", value: 16 },
    })
    expect(sanitizeLog({ level: "info", message: "room.performance", attributes: { name: "dictation_error", value: 1 } })?.level).toBe("error")
    for (const value of [NaN, Infinity, -1, 86_400_001, "private"]) {
      expect(sanitizeLog({ level: "info", message: "room.performance", attributes: { name: "LCP", value } })).toBeNull()
    }
    expect(sanitizeLog({ level: "info", message: "private" })).toBeNull()
  })

  it("disables tracing, replay, automatic data collection and unexpected integrations", () => {
    expect(sentryPrivacy.beforeSendTransaction()).toBeNull()
    expect(sentryPrivacy.beforeBreadcrumb()).toBeNull()
    expect(sentryPrivacy.integrations(["GlobalHandlers", "Replay", "Console", "Http", "BrowserTracing", "NewUnknownIntegration"].map((name) => ({ name })))).toEqual([{ name: "GlobalHandlers" }])
    expect(sentryPrivacy.dataCollection).toEqual({
      userInfo: false, cookies: false, httpHeaders: { request: false, response: false }, httpBodies: [],
      urlQueryParams: false, genAI: { inputs: false, outputs: false }, stackFrameVariables: false, frameContextLines: 0,
    })
  })
})
