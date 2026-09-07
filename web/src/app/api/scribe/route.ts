import { key } from "@/lib/elevenlabs"

export const dynamic = "force-dynamic"

/**
 * A single-use token for realtime transcription.
 *
 * The key never reaches the browser: ElevenLabs mints a token good for one
 * session and nothing else, which is the whole reason this endpoint exists
 * rather than the page holding the key itself.
 */
export async function POST() {
  const apiKey = key()
  if (!apiKey) return Response.json({ error: "no ELEVENLABS_API_KEY" }, { status: 503 })

  try {
    const res = await fetch(
      "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
      { method: "POST", headers: { "xi-api-key": apiKey } },
    )
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      return Response.json(
        { error: `elevenlabs said ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}` },
        { status: 502 },
      )
    }
    const data = await res.json()
    if (!data.token) return Response.json({ error: "no token in response" }, { status: 502 })
    return Response.json({ token: data.token as string })
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }
}
