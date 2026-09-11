import { agents } from "@/lib/agents"
import { ElevenLabsError } from "@elevenlabs/elevenlabs-js"

import { spendCharacters } from "@/lib/budget"
import { client, key, speechOff, TTS_LANGUAGE, TTS_MODEL } from "@/lib/elevenlabs"
import { caller, limiter } from "@/lib/rate-limit"
import { sameOrigin } from "@/lib/same-origin"
import { clipKey, readClip, writeClip } from "@/lib/speech-cache"
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
 * What comes back from the synthesiser.
 *
 * Halved from the default `mp3_44100_128` at the same sample rate. The clip is
 * base64 inside JSON, which is another third on top, and it is pulled down a
 * phone network by somebody waiting to hear a sentence. At conversational
 * length nobody can hear the difference through a phone speaker, and everybody
 * can feel the wait.
 */
const OUTPUT_FORMAT = "mp3_44100_64" as const

/**
 * How much of the line before this one the voice is told about.
 *
 * `previousText` is not spoken. It is context: a voice that knows the sentence
 * it is answering lands on the intonation of an answer instead of starting the
 * room again from silence. Capped because prosody needs the last breath, not
 * the last paragraph, and because this travels in a URL.
 */
const CONTEXT_CHARS = 300

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
  if (!apiKey || speechOff()) return Response.json({ error: "no ELEVENLABS_API_KEY" }, { status: 503 })
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

  const voice = voiceFor(agent, group)
  const key_ = clipKey({ voice, model: TTS_MODEL, language: TTS_LANGUAGE, format: OUTPUT_FORMAT, text: spoken })

  // Charged here and not earlier: the budget this protects is spent by the
  // call below, so everything a request can be rejected for should already
  // have rejected it. Ahead of the cache, though — a clip that already exists
  // costs the account nothing to make and is still bytes off a disk and down a
  // wire, and this bucket is the only thing between the route and somebody who
  // liked one of its answers a great deal.
  const allowed = speechLimit().take(caller(request))
  if (!allowed.ok) {
    return Response.json(
      { error: "too many lines at once" },
      { status: 429, headers: { "Retry-After": String(allowed.retryAfter) } },
    )
  }

  // Before the month's allowance, because the account was charged for this
  // line the first time somebody heard it and is not being charged again.
  const cached = readClip(key_)
  if (cached) return answer(cached)

  // The month's allowance, taken before the call rather than counted after it,
  // so two requests arriving together cannot both spend the last of it.
  const month = spendCharacters(spoken.length)
  if (!month.ok) {
    console.warn(JSON.stringify({ event: "speech.budget_spent", version: 1, used: month.used, limit: month.limit }))
    return Response.json({ error: "this room has spoken its fill for the month" }, { status: 503 })
  }

  /**
   * The line before this one, when the room can prove it said that too.
   *
   * It travels with its own grant because it is text on its way to the
   * provider, and "only what this room said" is not a rule that holds for the
   * line being spoken and lapses for the line beside it. Unsigned or missing,
   * it is simply dropped: context is an improvement, never a requirement.
   */
  const previous = params.get("previous") ?? ""
  const previousAgent = params.get("previousAgent") ?? ""
  const context = previous && previous.length <= CONTEXT_CHARS && grantAllows(previousAgent, previous, params.get("previousGrant"))
    ? sayable(previous)
    : ""

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
      {
        text: spoken,
        modelId: TTS_MODEL,
        outputFormat: OUTPUT_FORMAT,
        // Null means detect it, which is this room's decision and not a
        // default it fell into. See `speech.json`.
        ...(TTS_LANGUAGE ? { languageCode: TTS_LANGUAGE } : {}),
        ...(context ? { previousText: context } : {}),
      },
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

  const made = {
    audio: clip.audioBase64,
    // The characters as ElevenLabs read them, and when each one begins. Sent
    // rather than inferred from the text: what it was given and what it ended
    // up saying are not always the same string.
    chars: clip.alignment?.characters ?? [],
    starts: clip.alignment?.characterStartTimesSeconds ?? [],
  }
  // Kept for the next time this line is heard, which for a transcript anybody
  // scrolls back through is more often than it is said.
  writeClip(key_, made)
  return answer(made)
}

/** No-store to the browser either way: a cached clip is the server's business,
 *  and the page holds these in memory for as long as the room is open. */
function answer(clip: { audio: string; chars: string[]; starts: number[] }) {
  return Response.json(clip, { headers: { "Cache-Control": "no-store" } })
}
