"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { TrophyIcon } from "lucide-react"
import { CHALLENGE_TARGET, type ChallengeRun, type ScoreEntry } from "@/lib/challenge"

export function ChallengeMeter({ run }: { run: ChallengeRun | null }) {
  const score = run?.score ?? 0
  return <div className="challenge-meter">
    <div><span>One prompt</span><output aria-label="Challenge score" aria-live="polite">{score}<span> / {CHALLENGE_TARGET}</span></output></div>
    <progress value={score} max={CHALLENGE_TARGET} aria-label="Challenge progress" />
  </div>
}

const endings = {
  won: "You won!", quiet: "The conversation ended.", stopped: "Challenge stopped.",
  timeout: "Time’s up.", failed: "An agent couldn’t finish.", running: "Challenge in progress…",
}

export function ChallengeResult({ run, online, published }: { run: ChallengeRun; online: boolean; published: (run: ChallengeRun) => void }) {
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
  return <section className={`challenge-result ${run.status === "won" ? "challenge-won" : ""}`} aria-labelledby="challenge-result-title">
    {run.status === "won" && <TrophyIcon size={32} aria-hidden="true" />}
    <h2 id="challenge-result-title">{endings[run.status]}</h2>
    <p>{run.score} {run.score === 1 ? "reply" : "replies"} from one prompt.{run.score < CHALLENGE_TARGET ? " Reach 20 to win." : ""}</p>
    {run.submitted ? <p role="status">Result published. <Link href="/challenge/scoreboard">View global scoreboard</Link></p> :
      <form onSubmit={submit} aria-label="Publish result">
        <label htmlFor="challenger-name">Your name</label>
        <input id="challenger-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={24} autoComplete="nickname" required disabled={saving} aria-describedby="score-privacy" />
        <p id="score-privacy">Only your name and score will be public. Your prompt and conversation won’t be published.</p>
        {error && <p role="alert">{error}</p>}
        <button className="confirm-button" disabled={saving || !online || !name.trim()}>{saving ? "Publishing…" : "Publish score"}</button>
      </form>}
  </section>
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
  return <main className="scoreboard-page">
    <nav><Link href="/challenge">← Challenge</Link><Link href="/">The room</Link></nav>
    <header><TrophyIcon size={28} aria-hidden="true" /><h1>Global scoreboard</h1><p>One prompt. Reach 20 replies to win.</p></header>
    <div className="scoreboard-tools"><span>Top 50 · ties go to the first published</span><button onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button></div>
    {error && <p role="alert">The scoreboard couldn’t load. Try refreshing.</p>}
    {!error && entries?.length === 0 && <p className="scoreboard-empty">No scores yet. <Link href="/challenge">Play the first challenge.</Link></p>}
    {!!entries?.length && <ol className="scoreboard-list" aria-label="Global rankings">{entries.map((entry) => <li key={entry.id}>
      <span className="score-rank">{entry.rank}</span><span className="score-name">{entry.name}{entry.won && <small>Winner</small>}</span><span className="score-value">{entry.score}<span> / 20</span></span>
    </li>)}</ol>}
    <p className="scoreboard-footnote">Server-verified scores. Names are nicknames, not verified identities.</p>
  </main>
}
