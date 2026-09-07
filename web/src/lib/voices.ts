/**
 * Which voice an agent has, decided the same way the runtime decides it.
 *
 * This list is a copy of `VOICES` in `src/policy/voice.py`, in the same order,
 * because both sides of the project now speak: the browser streams a reply and
 * the terminal client synthesises one, and an agent that sounded like two
 * different people depending on where you were watching would be worse than an
 * agent that did not speak at all.
 *
 * A copy, not an import — a Next.js route cannot read a Python module — so a
 * test parses that file and fails if the two ever drift. See
 * `tests/web/voices.test.ts`.
 */
const VOICES = [
  "cgSgspJ2msm6clMCkdW9", // Jessica — female, american, young, conversational
  "onwK4e9ZLuTAKqWW03F9", // Daniel — male, british, formal
  "XrExE9yKIg1WjnnlVkGX", // Matilda — female, american, knowledgable
  "IKne3meq5aSn9XLyUdCD", // Charlie — male, australian, energetic
  "Xb7hH8MSUJpSbSDYk0k2", // Alice — female, british, clear
  "CwhRBWXzGAHq8TQ4Fs17", // Roger — male, american, laid-back
  "FGY2WhTYpPnrIDTdsKH5", // Laura — female, american, bright
  "SAz9YHcvj6GT2YYXdXww", // River — neutral, american, relaxed
  "pFZP5JQG7iQjIQuC4Bku", // Lily — female, british, velvety
  "nPczCjzI2devNBz1zQrb", // Brian — male, american, deep
]

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
