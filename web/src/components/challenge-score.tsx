"use client"

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { ListOrderedIcon, PlayIcon, TrophyIcon, XIcon } from "lucide-react"
import { CHALLENGE_TARGET, type ChallengeRun, type ScoreEntry, type Standing } from "@/lib/challenge"
import { cycleDialogFocus } from "@/lib/dialog-focus"

const endings = {
  won: "You won!", quiet: "Round finished", stopped: "Round stopped",
  timeout: "Time’s up.", failed: "An agent couldn’t finish.", running: "Challenge in progress…",
}

/**
 * The end of a round, which is mostly the start of the next one.
 *
 * There is nothing left to ask here. The name was given before the first line
 * was ever sent, so the score publishes itself and comes back with the only
 * thing worth showing at the end of a game: the place it took. What used to be
 * a form — type the name again, press publish, then find the quiet link that
 * plays again — is now one number and one button.
 *
 * A score of zero is the exception, and it is not published. Nobody wants their
 * name on a board for a round where nothing was said, and a place computed from
 * no replies is a punishment rather than a result.
 */
export function ChallengeResult({ run, standing, player, online, canPlay, published, dismiss, playAgain, showBoard }: {
  run: ChallengeRun
  standing: Standing | null
  player: string
  online: boolean
  canPlay: boolean
  published: (data: { run?: unknown; standing?: unknown }) => void
  dismiss: () => void
  playAgain: () => void
  showBoard: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Establish the native top layer/focus before anything can be interacted with.
  useLayoutEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])

  const publish = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const response = await fetch("/api/challenge/scoreboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: run.id, name: player }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Couldn’t reach the board. Your score is saved.")
      published(data)
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn’t reach the board. Your score is saved.") }
    finally { setSaving(false) }
  }, [run.id, player, published])

  // Once per attempt, and once more if the browser was offline when it ended:
  // the key changes with the connection, so coming back online finishes the job
  // and a rejection from the server does not retry itself in a loop.
  const attempted = useRef("")
  useEffect(() => {
    const attempt = `${run.id}:${online}`
    if (run.submitted || !run.score || !player || !online || attempted.current === attempt) return
    attempted.current = attempt
    // Publication is network I/O against a score the server already holds; the
    // dialog only reflects what comes back.
    void publish()
  }, [run.id, run.submitted, run.score, player, online, publish])

  function place() {
    if (!run.score) return <p className="result-standing">No replies to count. <span>Ask something two of them will want to answer.</span></p>
    if (standing) return <p className="result-standing" role="status"><b>#{standing.rank}</b> <span>of {standing.total} on the board</span></p>
    if (error) return <p className="result-standing" role="alert">{error} <button type="button" className="result-retry" onClick={() => void publish()} disabled={saving || !online}>Try again</button></p>
    if (saving) return <p className="result-standing" role="status">Saving your place…</p>
    if (!online) return <p className="result-standing" role="status">Offline. <span>Your score goes on the board when you’re back.</span></p>
    return <p className="result-standing" role="status">{run.submitted ? "Published." : "Saved."}</p>
  }

  return <dialog ref={dialog} className={`room-dialog challenge-result ${run.status === "won" ? "challenge-won" : ""}`} aria-labelledby="challenge-result-title" aria-describedby="challenge-final-score" onCancel={(event) => { event.preventDefault(); dismiss() }} onKeyDown={cycleDialogFocus}>
    <button className="icon-button result-close" aria-label="Back to the room" onClick={dismiss} autoFocus><XIcon size={18} /></button>
    <div className="result-trophy"><TrophyIcon size={32} strokeWidth={1.5} aria-hidden="true" /></div>
    <h2 id="challenge-result-title">{endings[run.status]}</h2>
    <p id="challenge-final-score" className="result-score" aria-label={`${run.score} of ${CHALLENGE_TARGET} replies`}>{run.score}<span>/{CHALLENGE_TARGET}</span></p>
    {place()}
    <button className="confirm-button" disabled={!canPlay} onClick={() => { dialog.current?.close(); playAgain() }}><PlayIcon size={18} aria-hidden="true" />Play again</button>
    <button className="result-again" onClick={() => { dialog.current?.close(); showBoard() }}><ListOrderedIcon size={15} aria-hidden="true" />See the board</button>
  </dialog>
}

export function Scoreboard() {
  const [entries, setEntries] = useState<ScoreEntry[] | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  async function load(signal?: AbortSignal) {
    setLoading(true)
    setError(false)
    try {
      const response = await fetch("/api/challenge/scoreboard", { signal, cache: "no-store" })
      if (!response.ok) throw new Error()
      const data = await response.json()
      if (!signal?.aborted) setEntries(data.entries)
    } catch { if (!signal?.aborted) setError(true) }
    finally { if (!signal?.aborted) setLoading(false) }
  }
  useEffect(() => {
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal)
    return () => controller.abort()
  }, [])
  return <section className="scoreboard" aria-labelledby="scoreboard-title">
    <header><h2 id="scoreboard-title">Global scoreboard</h2><p>One prompt. Reach 20 replies to win.</p></header>
    <div className="scoreboard-tools"><span>Top 50 · ties go to the first published</span><button onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button></div>
    {error && <p role="alert">The scoreboard couldn’t load. Try refreshing.</p>}
    {!error && entries?.length === 0 && <p className="scoreboard-empty">No scores yet. Be the first to play.</p>}
    {!!entries?.length && <ol className="scoreboard-list" aria-label="Global rankings">{entries.map((entry) => <li key={entry.id}>
      <span className="score-rank">{entry.rank}</span><span className="score-name">{entry.name}{entry.won && <small>Winner</small>}</span><span className="score-value">{entry.score}<span> / 20</span></span>
    </li>)}</ol>}
    <p className="scoreboard-footnote">Server-verified scores. Names are nicknames, not verified identities.</p>
  </section>
}
