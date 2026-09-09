import { parseSamples } from "@/lib/telemetry-schema"

export async function POST(request: Request) {
  const origin = request.headers.get("origin")
  // Host survives TLS-terminating proxies even when request.url uses the internal origin.
  const host = request.headers.get("host") ?? new URL(request.url).host
  if (origin) {
    try { if (new URL(origin).host !== host) return new Response(null, { status: 403 }) }
    catch { return new Response(null, { status: 403 }) }
  }
  const site = request.headers.get("sec-fetch-site")
  if (site && site !== "same-origin" && site !== "none") return new Response(null, { status: 403 })
  if (!request.headers.get("content-type")?.startsWith("application/json")) return new Response(null, { status: 415 })
  // Bound the actual stream too; Content-Length is not guaranteed or trusted.
  const reader = request.body?.getReader()
  if (!reader) return new Response(null, { status: 400 })
  let size = 0
  let body = ""
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 16_384) { await reader.cancel(); return new Response(null, { status: 413 }) }
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
    const samples = parseSamples(JSON.parse(body))
    if (!samples) return new Response(null, { status: 400 })
    console.info(JSON.stringify({ event: "frontend.performance", version: 1, samples }))
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } })
  } catch {
    return new Response(null, { status: 400 })
  } finally {
    reader.releaseLock()
  }
}
