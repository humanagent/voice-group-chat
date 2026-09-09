import { key } from "@/lib/elevenlabs"

export const dynamic = "force-dynamic"

/**
 * A single-use token for realtime transcription.
 *
 * The key never reaches the browser: ElevenLabs mints a token good for one
 * session and nothing else, which is the whole reason this endpoint exists
 * rather than the page holding the key itself.
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
