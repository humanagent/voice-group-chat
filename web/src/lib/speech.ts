import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * What the room sounds like, read from the one file that says so.
 *
 * `speech.json` at the repo root. This app used to carry its own copy of the
 * voice list and its own copy of the model id, with a test that parsed the
 * Python source to check the two had not drifted apart. Both sides of this
 * project speak — the browser asks for a reply out loud, the terminal client
 * synthesises one — and an agent that sounded like two different people
 * depending on where you were watching would be worse than one that stayed
 * silent. That is a reason to share the list, not to test two copies of it.
 *
 * Read from disk rather than imported, which is how this app already reads
 * `personas/` and `group.json`: the file sits beside the app rather than inside
 * it, and every one of its readers is server-side.
 */
type Speech = { model: string; language?: string | null; gate?: number; voices: { id: string; name?: string }[] }

/** Beside the app, or above it. `next start` runs from `web/`, and a script run
 *  from the repo root does not; naming both is cheaper than a deploy that
 *  cannot speak. */
const PLACES = [join(process.cwd(), "..", "speech.json"), join(process.cwd(), "speech.json")]

function load(): Speech {
  const failures: string[] = []
  for (const path of PLACES) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Speech>
      if (!parsed.model) throw new Error("no `model`")
      if (!parsed.voices?.length) throw new Error("no `voices`")
      const voices = parsed.voices.filter((voice) => voice?.id)
      if (voices.length !== parsed.voices.length) throw new Error("a voice with no `id`")
      if (parsed.language !== undefined && parsed.language !== null && (typeof parsed.language !== "string" || !parsed.language.trim())) {
        throw new Error("a `language` that is not a code")
      }
      const gate = parsed.gate ?? 0
      if (typeof gate !== "number" || !Number.isFinite(gate) || gate < 0 || gate >= 1) throw new Error("a `gate` that is not a level between 0 and 1")
      return { model: parsed.model, language: parsed.language?.trim() || null, gate, voices }
    } catch (failure) {
      failures.push(`${path}: ${failure instanceof Error ? failure.message : failure}`)
    }
  }
  // Loudly, and at startup. A room that cannot speak should say which file it
  // could not read, not fail ten voices later at the first reply.
  throw new Error(`could not read speech.json — ${failures.join("; ")}`)
}

const SPEECH = load()

/** What speaks the replies. The file carries the measurements behind it. */
export const TTS_MODEL = SPEECH.model

/**
 * What language to tell the voice and the transcriber to expect, or null.
 *
 * Null is a decision rather than an omission: this room is spoken to in two
 * languages and pinning one would make the other worse. It costs something —
 * autodetection is what heard "Ana" and wrote "Anna" — so `speech.json` says
 * which trade this room took, and a room that only speaks one language sets a
 * code there and stops paying for it.
 */
export const TTS_LANGUAGE = SPEECH.language ?? null

/**
 * How loud a moment has to be before the room sends it to be transcribed.
 *
 * The room's agents answer out loud, so on a phone the microphone hears them
 * through the speaker, and a transcriber has no opinion about which voice in
 * the room it is supposed to be writing down. Below this level the audio is
 * measured for the meter and then dropped: a chunk that never leaves the
 * browser cannot be transcribed, cannot be charged for and cannot be mistaken
 * for a word. Zero sends everything, as it always did.
 */
export const LISTEN_GATE = SPEECH.gate ?? 0

/**
 * One voice per agent, in this order.
 *
 * Position in the sorted group picks one, so the order IS the assignment and
 * reordering the file reshuffles who sounds like whom.
 */
export const VOICES = SPEECH.voices.map((voice) => voice.id)
