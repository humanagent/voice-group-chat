/**
 * What counts as somebody talking.
 *
 * You press to speak and press to stop, so the boundaries are yours and this
 * has one job left: deciding whether anything was actually said between them.
 * A room makes noise — a chair, a cough, a door — and a transcriber will hand
 * back a segment for any of it. Sending that to three agents as a message is
 * worse than saying nothing came back.
 *
 * Here rather than in the component because it is the part that can be wrong
 * in a way you can test.
 */

/** `[BLANK_AUDIO]`, `(música)` — a transcriber narrating what it heard rather
 *  than transcribing it. */
const ANNOTATION = /[[(][^\])]*[\])]/g

/** Sounds people make while thinking. On their own they are not a message; in
 *  the middle of a sentence they are harmless and stay. */
const FILLER = new Set([
  "uh", "um", "uhm", "erm", "er", "hm", "hmm", "mm", "mmm", "mhm", "ah", "ahh",
  "oh", "eh", "ehh", "em", "este", "esto", "aja", "ajá", "mmhm",
])

/** Words, lowercased, with the punctuation and the annotations gone. */
function words(text: string): string[] {
  return text
    .replace(ANNOTATION, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Is this a thing somebody said, or is it the room?
 *
 * One filler word is not a message; one real word is — "sí", "no" and "stop"
 * are whole turns in a conversation, and holding them back until a sentence
 * arrives is how a live microphone starts to feel deaf.
 */
export function worthSending(text: string): boolean {
  const said = words(text).filter((w) => !FILLER.has(w))
  if (!said.length) return false
  return said.join("").length >= 2
}
