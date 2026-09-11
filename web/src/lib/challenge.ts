/**
 * The versioned rules shared by the display and the server, never a client score.
 *
 * There is no number to reach. The round used to stop at twenty and call it a
 * win, which made the game a task with a ceiling: hit it and there was nothing
 * left to play for, miss it and the score was a fraction of somebody else's
 * idea. Now it runs for as long as the agents keep answering each other, and the
 * score is how far the conversation got — one point a reply, no target, no
 * winners, the way an endless game keeps a board interesting.
 *
 * What ends a round instead: the room goes quiet, the person stops it or leaves,
 * a failure prevents it from continuing, or the deadline arrives. The deadline is
 * therefore the only ceiling left, and it is a real one — it bounds the paid
 * turns a single prompt can spend.
 */
export const CHALLENGE_PROMPT_LIMIT = 2000
export const CHALLENGE_DURATION_MS = 240_000
export const challengeStatuses = ["running", "quiet", "stopped", "timeout", "failed"] as const
export type ChallengeStatus = (typeof challengeStatuses)[number]
export type ChallengeRun = {
  id: string
  score: number
  status: ChallengeStatus
  submitted: boolean
}
export type ScoreEntry = { id: string; rank: number; name: string; score: number }
/**
 * Where a published attempt landed, and how crowded the board is.
 *
 * The board itself stops at fifty. A place is the one number a player wants
 * back the moment a round ends, and it has to exist for the four-hundredth
 * score as much as for the fourth.
 */
export type Standing = { rank: number; total: number }

/** One point is one reply, and one reply is never "1 replies". */
export const replyWord = (score: number) => score === 1 ? "reply" : "replies"
/** A score in words, for anybody listening to the room rather than watching it. */
export const replies = (score: number) => `${score} ${replyWord(score)}`

export function isChallengeRun(value: unknown): value is ChallengeRun {
  if (!value || typeof value !== "object") return false
  const run = value as ChallengeRun
  // No upper bound to check any more, so the check that matters is that the
  // score is a whole countable number: a run half-written by a storage failure
  // rendered a dialog with an empty heading and a score reading "/20", and it
  // must still become no result at all rather than a dialog reading "NaN".
  return typeof run.id === "string" && /^[\da-f-]{36}$/.test(run.id) &&
    Number.isSafeInteger(run.score) && run.score >= 0 &&
    challengeStatuses.includes(run.status) && typeof run.submitted === "boolean"
}

/** A place is two whole numbers, the first of them inside the second. */
export function isStanding(value: unknown): value is Standing {
  if (!value || typeof value !== "object") return false
  const standing = value as Standing
  return Number.isInteger(standing.rank) && Number.isInteger(standing.total) && standing.rank >= 1 && standing.rank <= standing.total
}

/** Public nicknames, not verified identities. No markup, controls or invisible text. */
export function publicName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const name = value.normalize("NFKC").trim().replace(/ +/g, " ")
  if ([...name].length < 1 || [...name].length > 24 || !/^[\p{L}\p{M}\p{N} ._'’-]+$/u.test(name) || !/[\p{L}\p{N}]/u.test(name)) return null
  return name
}
