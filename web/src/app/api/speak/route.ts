import { agents } from "@/lib/agents"
import { ElevenLabsError } from "@elevenlabs/elevenlabs-js"

import { client, key, TTS_MODEL } from "@/lib/elevenlabs"
import { caller, limiter } from "@/lib/rate-limit"
import { sameOrigin } from "@/lib/same-origin"
import { grantAllows } from "@/lib/speech-grant"
import { sayable, voiceFor } from "@/lib/voices"

export const dynamic = "force-dynamic"
export const maxDuration = 120

/**
 * The longest line this will read.
 *
 * Every reply the room produces is clamped well under this before it is ever
 * emitted, so nothing legitimate meets it; a reply that attached a file skips
 * that clamp and is the only thing that could. It is here as a bound on the
 * work one request can ask for, not as the thing keeping strangers out — that
 * is the grant.
 */
const MAX_SPEECH_CHARS = 1000

/**
 * What a browser may ask to hear, and what all of them together may.
 *
 * A round is three agents, and a person reading along starts one round every
 * several seconds, so a burst of twelve with twenty a minute is generous for
 * one reader and nowhere near enough to be worth abusing. The ceiling is what
 * the account can actually lose in a minute if every check above it is somehow
 * wrong.
 */
const speechLimit = () => limiter("speech", { perMinute: 20, burst: 12 }, { perMinute: 120, burst: 60 })

/**
 * A reply, out loud.
 *
 * The runtime used to synthesise inside the turn and hand back a file, which
 * meant the REPLY did not leave the agent until the MP3 existed — measured at
 * 1.96s of a 4.14s turn, spent on a room with nothing in it. Speech belongs to
 * whoever wants to hear it, so it happens here instead.
 *
 * It will only say what the room said. The text arrives with the signature the
 * room issued when it emitted that line, and nothing without one is
 * synthesised: an agent name and a string of text are not, on their own,
 * permission to spend the account's voice budget. See `speech-grant.ts`.
 *
 * The agent is named rather than the voice, because the voice is not the
 * caller's to choose. Which one an agent has is decided from its position in
 * the group, in one place, so the browser and the terminal give it the same
 * voice and a client cannot put words in somebody else's mouth.
 *
 * It answers JSON rather than audio because it asks for the clip WITH ITS
 * TIMINGS: where in the recording each character of the reply is spoken. That
 * is what lets the transcript follow the voice through the line instead of
 * sitting there finished while somebody is still saying it.
 */
export async function GET(request: Request) {
  const apiKey = key()
  if (!apiKey) return Response.json({ error: "no ELEVENLABS_API_KEY" }, { status: 503 })
  if (!sameOrigin(request)) return Response.json({ error: "not this room" }, { status: 403 })

  const params = new URL(request.url).searchParams
  const agent = params.get("agent") ?? ""
  const text = params.get("text") ?? ""
  if (!agent || !text) return Response.json({ error: "agent and text are required" }, { status: 400 })
  if (text.length > MAX_SPEECH_CHARS) return Response.json({ error: "line too long to speak" }, { status: 413 })

  // Signed over what the room emitted, so this is checked against the text as
  // it arrived — before the emoji come off, which is a decision this route
  // makes and not part of what was said.
  if (!grantAllows(agent, text, params.get("grant"))) {
    return Response.json({ error: "not something this room said" }, { status: 403 })
  }

  const group = agents().map((a) => a.name)
  if (!group.includes(agent)) {
    return Response.json({ error: "not an agent in this group" }, { status: 400 })
  }

  const spoken = sayable(text)
  if (!spoken) return Response.json({ error: "nothing to say" }, { status: 400 })

  // Charged here and not earlier: the budget this protects is spent by the
  // call below, so everything a request can be rejected for should already
  // have rejected it.
  const allowed = speechLimit().take(caller(request))
  if (!allowed.ok) {
    return Response.json(
      { error: "too many lines at once" },
      { status: 429, headers: { "Retry-After": String(allowed.retryAfter) } },
    )
  }

  const voice = voiceFor(agent, group)

  // Held whole, which this endpoint does anyway — there is no streaming
  // variant of the timings, and there was nothing to stream. Measured on a
  // 211-character reply, generating the whole clip took 2.3s against 1.9s to
  // the first byte of the stream, a difference inside the run-to-run variance.
  //
  // The audio comes back base64, a third larger than the bytes. Worth it: the
  // alternative is a second request for the timings, against an endpoint that
  // would synthesise the line a second time to produce them.
  let clip
  try {
    clip = await client(apiKey).textToSpeech.convertWithTimestamps(
      voice,
      { text: spoken, modelId: TTS_MODEL },
      // One retry, not the SDK's default of two. This sits inside a turn
      // somebody is waiting through, and a third attempt costs more time than
      // the audio is worth by the time it would arrive.
      { maxRetries: 1, timeoutInSeconds: 30, abortSignal: request.signal },
    )
  } catch (failure) {
    // A reply you can read is worth more than one you can hear, so this never
    // fails the turn — the client plays nothing and the room carries on.
    //
    // The provider's own body is never returned or logged; it can carry the
    // submitted text back. The request id is what a support conversation
    // actually needs, and it identifies the call rather than describing it.
    const known = failure instanceof ElevenLabsError
    console.warn(JSON.stringify({
      event: "speech.synthesis_failed",
      version: 1,
      upstreamStatus: known ? failure.statusCode : undefined,
      upstreamRequestId: known ? failure.requestId : undefined,
    }))
    return Response.json(
      { error: known ? `elevenlabs said ${failure.statusCode ?? "nothing"}` : "could not reach elevenlabs" },
      { status: 502 },
    )
  }

  if (!clip.audioBase64) {
    return Response.json({ error: "no audio in response" }, { status: 502 })
  }

  return Response.json(
    {
      audio: clip.audioBase64,
      // The characters as ElevenLabs read them, and when each one begins.
      // Sent rather than inferred from the text: what it was given and what it
      // ended up saying are not always the same string.
      chars: clip.alignment?.characters ?? [],
      starts: clip.alignment?.characterStartTimesSeconds ?? [],
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}
