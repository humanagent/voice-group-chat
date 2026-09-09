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
type Speech = { model: string; voices: { id: string; name?: string }[] }

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
      return { model: parsed.model, voices }
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
 * One voice per agent, in this order.
 *
 * Position in the sorted group picks one, so the order IS the assignment and
 * reordering the file reshuffles who sounds like whom.
 */
export const VOICES = SPEECH.voices.map((voice) => voice.id)
