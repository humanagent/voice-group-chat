"use client"

import { useEffect, useRef, useState } from "react"
import { TrophyIcon, XIcon } from "lucide-react"
import { CHALLENGE_TARGET, type ChallengeRun, type ScoreEntry } from "@/lib/challenge"
import { useKeyboardFocus } from "@/hooks/use-keyboard-focus"
import { cycleDialogFocus } from "@/lib/dialog-focus"

const endings = {
  won: "You won!", quiet: "Round finished", stopped: "Round stopped",
  timeout: "Time’s up.", failed: "An agent couldn’t finish.", running: "Challenge in progress…",
}

export function ChallengeResult({ run, online, published, dismiss, playAgain }: { run: ChallengeRun; online: boolean; published: (run: ChallengeRun) => void; dismiss: () => void; playAgain: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const keyboardFocus = useKeyboardFocus<HTMLInputElement>()
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (saving || !online || run.submitted) return
    setSaving(true)
    setError(null)
    try {
      const response = await fetch("/api/challenge/scoreboard", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: run.id, name }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Couldn’t publish. Your result is saved; try again.")
      published(data.run)
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn’t publish. Try again.") }
    finally { setSaving(false) }
  }
  return <dialog ref={dialog} className={`challenge-result ${run.status === "won" ? "challenge-won" : ""}`} aria-labelledby="challenge-result-title" aria-describedby="challenge-final-score" onCancel={(event) => { event.preventDefault(); dismiss() }} onKeyDown={cycleDialogFocus}>
    <button className="icon-button result-close" aria-label="Back to the room" onClick={dismiss} autoFocus><XIcon size={18} /></button>
    <div className="result-trophy"><TrophyIcon size={32} strokeWidth={1.5} aria-hidden="true" /></div>
    <h2 id="challenge-result-title">{endings[run.status]}</h2>
    <p id="challenge-final-score" className="result-score" aria-label={`${run.score} of ${CHALLENGE_TARGET} replies`}>{run.score}<span>/{CHALLENGE_TARGET}</span></p>
    {run.submitted ? <p role="status">Result published.</p> :
      <form onSubmit={submit} aria-label="Publish result">
        <label htmlFor="challenger-name">Your name</label>
        <input {...keyboardFocus} id="challenger-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={24} autoComplete="nickname" required disabled={saving} aria-describedby="score-privacy" />
        <p id="score-privacy">Name and score are public.</p>
        {error && <p role="alert">{error}</p>}
        <button className="confirm-button" disabled={saving || !online || !name.trim()}>{saving ? "Publishing…" : "Publish score"}</button>
      </form>}
    <button className="result-again" onClick={playAgain} disabled={saving || !online}>{run.submitted ? "Play again" : "Skip & play again"}</button>
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
