import { key } from "@/lib/elevenlabs"
import { caller, limiter } from "@/lib/rate-limit"
import { sameOrigin } from "@/lib/same-origin"

export const dynamic = "force-dynamic"

/**
 * What one browser, and all of them, may open.
 *
 * A person records a few times a minute at most, and each token is one session.
 * A stranger who could mint them freely would be handing themselves live
 * transcription on this account, which is why the cheap checks below run before
 * anything reaches ElevenLabs.
 */
const tokenLimit = () => limiter("scribe", { perMinute: 10, burst: 5 }, { perMinute: 60, burst: 20 })

/**
 * A single-use token for realtime transcription.
 *
 * The key never reaches the browser: ElevenLabs mints a token good for one
 * session and nothing else, which is the whole reason this endpoint exists
 * rather than the page holding the key itself.
 *
 * A token is still worth something to a stranger, so it is rationed and refused
 * outright to a page that is not this one.
 */
export async function POST(request: Request) {
  const suppliedId = request.headers.get("x-request-id")
  const requestId = suppliedId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedId)
    ? suppliedId : crypto.randomUUID()
  const started = performance.now()
  const headers = { "Cache-Control": "no-store", "X-Request-ID": requestId }
  let outcome = "unavailable"
  let upstreamStatus: number | undefined
  try {
    const apiKey = key()
    if (!apiKey) {
      outcome = "not_configured"
      return Response.json({ error: "Voice is not configured." }, { status: 503, headers })
    }
    if (!sameOrigin(request)) {
      outcome = "cross_origin"
      return Response.json({ error: "Use this site's microphone." }, { status: 403, headers })
    }
    const allowed = tokenLimit().take(caller(request))
    if (!allowed.ok) {
      outcome = "rate_limited"
      return Response.json({ error: "Too many recordings just now. Try again shortly." }, {
        status: 429, headers: { ...headers, "Retry-After": String(allowed.retryAfter) },
      })
    }
    const res = await fetch(
      "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
      {
        method: "POST", headers: { "xi-api-key": apiKey }, cache: "no-store",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      },
    )
    upstreamStatus = res.status
    if (!res.ok) {
      outcome = "provider_error"
      return Response.json({ error: "Transcription service unavailable." }, { status: 502, headers })
    }
    const data = await res.json()
    if (typeof data.token !== "string" || !data.token) {
      outcome = "invalid_response"
      return Response.json({ error: "Transcription service unavailable." }, { status: 502, headers })
    }
    outcome = "ready"
    return Response.json({ token: data.token }, { headers })
  } catch {
    outcome = request.signal.aborted ? "cancelled" : "network_error"
    return Response.json({ error: "Transcription service unavailable." }, { status: 502, headers })
  } finally {
    // Never log the provider body, credentials, token, request URL or error stack.
    console.info(JSON.stringify({ event: "speech.token", version: 1, requestId, outcome, upstreamStatus, durationMs: Math.round(performance.now() - started) }))
  }
}
