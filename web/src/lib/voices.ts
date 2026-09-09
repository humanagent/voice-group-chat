import { VOICES } from "@/lib/speech"

/**
 * Which voice an agent has, decided the same way the runtime decides it.
 *
 * The list lives in `speech.json` at the repo root, which the Python reads too.
 * It used to be a copy kept honest by a test that parsed `src/policy/voice.py`
 * from TypeScript, which caught drift but could not prevent it.
 */

/**
 * A voice for this agent, distinct from the others in the group.
 *
 * Position in the sorted group, not a hash of the name: hashing was stable and
 * collided, and two agents sharing a voice defeats the entire point. Sorted
 * first so the answer does not depend on the order somebody listed them in.
 */
export function voiceFor(name: string, among?: string[]): string {
  if (among?.length) {
    const ordered = [...among].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    const at = ordered.indexOf(name)
    if (at >= 0) return VOICES[at % VOICES.length]
  }
  let hash = 0
  for (const ch of name.toLowerCase()) hash += ch.codePointAt(0) ?? 0
  return VOICES[hash % VOICES.length]
}

/**
 * What a voice cannot say. Emoji get read out as their names — "Hey Fabri
 * waving hand" — so they come off on the way to the synthesiser only. The
 * written reply keeps them, because there they are the tone.
 */
const UNSPEAKABLE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{1F3FB}-\u{1F3FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{200D}]+/gu

/** Nothing is replaced with a word: an emoji at the end of a sentence is tone,
 *  and tone that has to be pronounced stops being tone. */
export function sayable(text: string): string {
  return (text ?? "")
    .replace(UNSPEAKABLE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?…])/g, "$1")
    .trim()
}

export { VOICES }
