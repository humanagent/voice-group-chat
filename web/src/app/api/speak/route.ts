import { agents } from "@/lib/agents"
import { key, TTS_MODEL } from "@/lib/elevenlabs"
import { sayable, voiceFor } from "@/lib/voices"

export const dynamic = "force-dynamic"
export const maxDuration = 120

/**
 * A reply, out loud.
 *
 * The runtime used to synthesise inside the turn and hand back a file, which
 * meant the REPLY did not leave the agent until the MP3 existed — measured at
 * 1.96s of a 4.14s turn, spent on a room with nothing in it. Speech belongs to
 * whoever wants to hear it, so it happens here instead.
 *
 * The agent is named rather than the voice, because the voice is not the
 * caller's to choose. Which one an agent has is decided from its position in
 * the group, in one place, so the browser and the terminal give it the same
 * voice and a client cannot put words in somebody else's mouth.
 *
 * A GET, with the text in the query, so one URL is the whole request.
 *
 * It answers JSON rather than audio because it asks for the clip WITH ITS
 * TIMINGS: where in the recording each character of the reply is spoken. That
 * is what lets the transcript follow the voice through the line instead of
 * sitting there finished while somebody is still saying it.
 */
export async function GET(request: Request) {
  const apiKey = key()
  if (!apiKey) return Response.json({ error: "no ELEVENLABS_API_KEY" }, { status: 503 })

  const params = new URL(request.url).searchParams
  const agent = params.get("agent")
  const speech = sayable(params.get("text") ?? "")
  if (!agent || !speech) {
    return Response.json({ error: "agent and text are required" }, { status: 400 })
  }

  const group = agents().map((a) => a.name)
  if (!group.includes(String(agent))) {
    return Response.json({ error: "not an agent in this group" }, { status: 400 })
  }

  const voice = voiceFor(String(agent), group)
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps`,
    {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ text: speech, model_id: TTS_MODEL }),
    },
  ).catch(() => null)

  if (!res?.ok || !res.body) {
    // A reply you can read is worth more than one you can hear, so this never
    // fails the turn — the client plays nothing and the room carries on.
    const detail = res ? await res.text().catch(() => "") : "could not reach elevenlabs"
    return Response.json(
      { error: detail.slice(0, 200) || `elevenlabs said ${res?.status}` },
      { status: 502 },
    )
  }

  // Held whole, which this endpoint does anyway — there is no streaming
  // variant of the timings, and there was nothing to stream. Measured on a
  // 211-character reply, generating the whole clip took 2.3s against 1.9s to
  // the first byte of the stream, a difference inside the run-to-run variance.
  // The two seconds this route actually saves were never the download; they
  // were the turn no longer waiting on the synthesiser.
  //
  // The audio comes back base64 in the JSON, a third larger than the bytes.
  // Worth it: the alternative is a second request for the timings, against an
  // endpoint that would synthesise the line a second time to produce them.
  const data = (await res.json().catch(() => null)) as {
    audio_base64?: string
    alignment?: {
      characters?: string[]
      character_start_times_seconds?: number[]
    }
  } | null

  if (!data?.audio_base64) {
    return Response.json({ error: "no audio in response" }, { status: 502 })
  }

  return Response.json(
    {
      audio: data.audio_base64,
      // The characters as ElevenLabs read them, and when each one begins.
      // Sent rather than inferred from the text: what it was given and what it
      // ended up saying are not always the same string.
      chars: data.alignment?.characters ?? [],
      starts: data.alignment?.character_start_times_seconds ?? [],
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}
