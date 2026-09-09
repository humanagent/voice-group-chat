/** The versioned rules shared by the display and the server, never a client score. */
export const CHALLENGE_TARGET = 20
export const CHALLENGE_PROMPT_LIMIT = 2000
export const CHALLENGE_DURATION_MS = 240_000
export const challengeStatuses = ["running", "won", "quiet", "stopped", "timeout", "failed"] as const
export type ChallengeStatus = (typeof challengeStatuses)[number]
export type ChallengeRun = {
  id: string
  score: number
  target: typeof CHALLENGE_TARGET
  status: ChallengeStatus
  submitted: boolean
}
export type ScoreEntry = { id: string; rank: number; name: string; score: number; won: boolean }

export function isChallengeRun(value: unknown): value is ChallengeRun {
  if (!value || typeof value !== "object") return false
  const run = value as ChallengeRun
  return typeof run.id === "string" && /^[\da-f-]{36}$/.test(run.id) &&
    Number.isInteger(run.score) && run.score >= 0 && run.score <= CHALLENGE_TARGET &&
    run.target === CHALLENGE_TARGET && challengeStatuses.includes(run.status) &&
    typeof run.submitted === "boolean" && (run.status !== "won" || run.score === CHALLENGE_TARGET)
}

/** Public nicknames, not verified identities. No markup, controls or invisible text. */
export function publicName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const name = value.normalize("NFKC").trim().replace(/ +/g, " ")
  if ([...name].length < 1 || [...name].length > 24 || !/^[\p{L}\p{M}\p{N} ._'’-]+$/u.test(name) || !/[\p{L}\p{N}]/u.test(name)) return null
  return name
}
