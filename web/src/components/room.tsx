"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowDownToLineIcon, ListOrderedIcon, MessagesSquareIcon, RefreshCwIcon, TrophyIcon, WifiOffIcon, XIcon } from "lucide-react"
import { ChallengeResult, Scoreboard } from "@/components/challenge-score"
import { ChallengeIntro } from "@/components/challenge-intro"
import { CHALLENGE_PROMPT_LIMIT, type ChallengeRun } from "@/lib/challenge"
import { ChatMessage, type Line } from "@/components/chat-message"
import { Composer, type ComposerHandle } from "@/components/composer"
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ui/conversation"
import { Stage, type Phase } from "@/components/stage"
import { usePwa } from "@/hooks/use-pwa"
import { useRoomViewport } from "@/hooks/use-room-viewport"
import { Voice } from "@/lib/speaking"
import { roomEvents } from "@/lib/room-stream"
import { record, sampleFrames } from "@/lib/telemetry"
import type { DictationState } from "@/lib/dictation"

type Pending = { id: string; text: string; counted: boolean }

export function Room({ names, speech, initialScoreboard = false }: { names: string[]; speech: boolean; initialScoreboard?: boolean }) {
  useRoomViewport()
  const [chat, setChat] = useState<string | null>(null)
  const [opening, setOpening] = useState(names.length > 0)
  const [phase, setPhase] = useState<Record<string, Phase>>({})
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState<DictationState["status"]>("idle")
  const listening = recording !== "idle"
  const [error, setError] = useState<string | null>(null)
  const [installHelp, setInstallHelp] = useState(false)
  const [challengeRun, setChallengeRun] = useState<ChallengeRun | null>(null)
  const [scoreboard, setScoreboard] = useState(initialScoreboard)
  const [counting, setCounting] = useState(false)
  const [dismissedRun, setDismissedRun] = useState<string | null>(null)
  const [introOpen, setIntroOpen] = useState(false)
  const pwa = usePwa()
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const waiting = useRef<Pending[]>([])
  const draining = useRef(false)
  const voice = useRef<Voice | null>(null)
  const round = useRef<AbortController | null>(null)
  const opener = useRef<AbortController | null>(null)
  const composer = useRef<ComposerHandle | null>(null)
  const speechEnabled = useRef(speech)
  const scroller = useRef<{ scrollToBottom: (options?: { animation?: "instant"; wait?: boolean }) => unknown } | null>(null)

  const show = useCallback((agent: string, next: Phase) => {
    clearTimeout(timers.current[agent])
    setPhase((current) => current[agent] === next ? current : { ...current, [agent]: next })
    if (next === "quiet" || next === "speaking") timers.current[agent] = setTimeout(() => {
      setPhase((current) => current[agent] === next ? { ...current, [agent]: "listening" } : current)
    }, next === "quiet" ? 1200 : 2600)
  }, [])

  useEffect(() => {
    voice.current = new Voice(
      (agent) => { clearTimeout(timers.current[agent]); setPhase((current) => ({ ...current, [agent]: "speaking" })); sampleFrames() },
      (agent) => setPhase((current) => current[agent] === "speaking" ? { ...current, [agent]: "listening" } : current),
    )
    const running = timers.current
    return () => {
      round.current?.abort()
      opener.current?.abort()
      waiting.current = []
      voice.current?.stop()
      Object.values(running).forEach(clearTimeout)
    }
  }, [])

  useEffect(() => { speechEnabled.current = speech }, [speech])
  const level = useCallback(() => voice.current?.level() ?? 0, [])
  const where = useCallback(() => voice.current?.saying() ?? null, [])
  const restore = useCallback((text: string) => composer.current?.restore(text), [])

  const open = useCallback(async () => {
    opener.current?.abort()
    const controller = new AbortController()
    opener.current = controller
    const start = performance.now()
    try {
      const response = await fetch("/api/room", { signal: controller.signal })
      if (!response.ok) throw new Error("The room isn’t available yet. Try connecting again.")
      const data = await response.json()
      if (!data.chat) throw new Error("The room couldn’t open. Try again in a moment.")
      const history = await fetch(`/api/history?chat=${encodeURIComponent(data.chat)}`, { signal: controller.signal })
      if (!history.ok) throw new Error("The conversation couldn’t load. Try connecting again.")
      const previous = await history.json()
      // Restore the counter independently of the shared conversation. A score
      // storage outage must not prevent ordinary chat from opening.
      try {
        const saved = await fetch("/api/challenge", { signal: controller.signal, cache: "no-store" })
        if (saved.ok) {
          const data = await saved.json()
          if (!controller.signal.aborted) {
            setChallengeRun(data.run)
            if (data.run?.submitted) setDismissedRun(data.run.id)
          }
        }
      } catch { /* Ordinary chat remains available without score storage. */ }
      if (controller.signal.aborted) return
      setLines((previous.lines ?? []).map((line: Pick<Line, "speaker" | "text" | "spoken">, i: number) => ({ ...line, id: `history-${i}` })))
      setChat(data.chat)
      record("room_ready", performance.now() - start)
    } catch (failure) {
      if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : "Couldn’t connect to the room."); record("room_error", 1) }
    } finally { if (!controller.signal.aborted) setOpening(false) }
  }, [])

  useEffect(() => {
    // Opening synchronizes with the server; state changes happen after network I/O.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (names.length) void open()
    return () => opener.current?.abort()
  }, [names.length, open])

  // A refresh can arrive before a disconnected run finishes cancelling. Recover
  // its persisted result without re-sending the prompt or minting another run.
  useEffect(() => {
    if (busy || challengeRun?.status !== "running") return
    const controller = new AbortController()
    const timer = setInterval(() => {
      void fetch("/api/challenge", { signal: controller.signal, cache: "no-store" }).then(async (response) => {
        if (response.ok) { const data = await response.json(); if (!controller.signal.aborted) setChallengeRun(data.run) }
      }).catch(() => {})
    }, 2000)
    return () => { clearInterval(timer); controller.abort() }
  }, [busy, challengeRun?.status])

  const hush = useCallback(() => {
    voice.current?.stop()
    round.current?.abort()
    const queued = new Set(waiting.current.map((item) => item.id))
    waiting.current = []
    setLines((current) => current.map((line) => queued.has(line.id) ? { ...line, delivery: "not-sent" } : line))
    Object.values(timers.current).forEach(clearTimeout)
    setPhase({})
  }, [])

  function delivery(id: string, status: Line["delivery"]) {
    setLines((current) => current.map((line) => line.id === id && line.delivery !== status ? { ...line, delivery: status } : line))
  }

  async function say(item: Pending): Promise<boolean> {
    const controller = new AbortController()
    round.current = controller
    const start = performance.now()
    let first = true
    let accepted = false
    delivery(item.id, "sending")
    try {
      const response = await fetch(item.counted ? "/api/challenge" : "/api/say", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.counted ? { message: item.text } : { chat, message: item.text }), signal: controller.signal })
      if (!response.ok) {
        const data = await response.json()
        delivery(item.id, "not-sent")
        setError(data.error || "Your message couldn’t send. Try again.")
        return false
      }
      accepted = true
      for await (const event of roomEvents(response)) {
        delivery(item.id, "sent")
        if (event.type === "challenge") setChallengeRun(event.run)
        else if (event.type === "thinking") show(event.agent, "thinking")
        else if (event.type === "quiet") show(event.agent, "quiet")
        else if (event.type === "failed") { show(event.agent, "unreachable"); setError(`${event.agent} couldn’t answer. You can try again in a moment.`); record("room_error", 1) }
        else if (event.type === "said") {
          if (first) { record("first_reply", performance.now() - start); first = false }
          const spoken = speechEnabled.current && (speech || !!event.audio)
          if (spoken) voice.current?.play(event.agent, event.audio ? `/api/audio?path=${encodeURIComponent(event.audio)}` : `/api/speak?agent=${encodeURIComponent(event.agent)}&text=${encodeURIComponent(event.text)}`)
          else show(event.agent, "speaking")
          setLines((current) => [...current, { id: crypto.randomUUID(), speaker: event.agent, text: event.text, spoken, animate: true }])
          sampleFrames()
        }
      }
      record("round_duration", performance.now() - start)
      return true
    } catch {
      delivery(item.id, controller.signal.aborted ? "interrupted" : "uncertain")
      if (!controller.signal.aborted) { setError("The connection was interrupted. Your message may have arrived; review the conversation before sending it again."); record("stream_error", 1) }
      setPhase((current) => Object.fromEntries(Object.entries(current).map(([name, state]) => [name, state === "thinking" ? "listening" : state])))
      return false
    } finally {
      if (round.current === controller) round.current = null
      if (item.counted && accepted) {
        setCounting(false)
        try {
          const response = await fetch("/api/challenge", { cache: "no-store" })
          if (response.ok) { const data = await response.json(); setChallengeRun(data.run) }
        } catch { /* The streamed result remains usable; a reload recovers it. */ }
        setPhase({})
      }
    }
  }

  async function drain() {
    if (draining.current) return
    draining.current = true
    setBusy(true)
    try {
      let next: Pending | undefined
      while ((next = waiting.current.shift())) {
        if (!await say(next)) {
          for (const item of waiting.current) delivery(item.id, "not-sent")
          waiting.current = []
          break
        }
      }
    } finally { draining.current = false; setBusy(false) }
  }

  function submit(text: string, counted = counting) {
    if (!chat || opening || !navigator.onLine || !text.trim()) return false
    if (challengeRun?.status === "running" || (counted && (draining.current || text.length > CHALLENGE_PROMPT_LIMIT))) return false
    const item = { id: crypto.randomUUID(), text: text.trim(), counted }
    setLines((current) => [...current, { ...item, speaker: "you", spoken: false, animate: true, delivery: draining.current ? "queued" : "sending" }])
    setError(null)
    waiting.current.push(item)
    scroller.current?.scrollToBottom({ animation: "instant", wait: true })
    void drain()
    return true
  }

  const talking = names.find((name) => phase[name] === "speaking")
  const reading = talking ? lines.findLastIndex((line) => line.speaker === talking) : -1
  const thinking = names.filter((name) => phase[name] === "thinking")
  const status = !pwa.online ? "Offline" : opening ? "Connecting…" : !chat ? "Disconnected"
    : recording === "connecting" ? "Connecting microphone…" : recording === "finishing" ? "Finishing transcription…"
    : listening ? "Recording…" : busy ? "Responding…" : counting ? "Next prompt counts" : null

  const canChallenge = !opening && !!chat && !busy && !listening && pwa.online && challengeRun?.status !== "running"

  function openChallenge() {
    if (canChallenge) setIntroOpen(true)
  }

  function startChallenge() {
    if (opening || !chat || busy || listening || !pwa.online || challengeRun?.status === "running") return
    setIntroOpen(false)
    voice.current?.stop()
    setChallengeRun(null)
    setDismissedRun(null)
    setCounting(true)
    setError(null)
    setScoreboard(false)
    if (!composer.current?.startRecording()) setError("Voice is unavailable. You can type your prompt.")
  }

  function showScoreboard() {
    // Never navigate/unmount a live attempt to inspect the ranking.
    setScoreboard(true)
  }

  function showRoom() {
    setScoreboard(false)
    if (!busy) setCounting(false)
    if (challengeRun?.status !== "running") setDismissedRun(challengeRun?.id ?? null)
  }

  const savedAttempt = challengeRun && !challengeRun.submitted

  return (
    <main className="room-page">
      <section className="room-shell" data-scoreboard={scoreboard} aria-label="The room" aria-busy={opening}>
        <header className="room-header">
          <div><h1>{scoreboard ? "Challenge" : "The room"}</h1>{status && <p className="room-status" role="status">{status}</p>}</div>
          <nav className="room-actions" aria-label="Room modes">
            <button className="icon-button" onClick={showRoom} disabled={listening} aria-label={scoreboard ? "Back to the room" : "Room mode"} aria-current={!scoreboard ? "page" : undefined} title="Room"><MessagesSquareIcon size={18} /></button>
            <button className="icon-button" onClick={openChallenge} disabled={!canChallenge} aria-label="Start challenge" title="Challenge"><TrophyIcon size={18} /></button>
            <button className="icon-button" onClick={showScoreboard} disabled={listening} aria-label="Global scoreboard" aria-current={scoreboard ? "page" : undefined} title="Leaderboard"><ListOrderedIcon size={18} /></button>
            {!pwa.installed && (pwa.canInstall || pwa.ios) && <button className="icon-button" onClick={() => pwa.canInstall ? void pwa.install() : setInstallHelp(true)} aria-label="Install the room" title="Install the room"><ArrowDownToLineIcon size={18} /></button>}
          </nav>
        </header>
        <div className="stage-wrap"><Stage names={names} phase={phase} level={level} /></div>
        {scoreboard && <div className="challenge-lobby"><Scoreboard /></div>}
        <Conversation className="room-conversation" initial="instant" resize="instant" contextRef={scroller as React.Ref<never>} aria-label="Conversation" aria-live="polite" aria-relevant="additions">
          <ConversationContent className="transcript-content">
            {!names.length && <p className="room-empty">No agents configured.</p>}
            {lines.map((line, i) => <ChatMessage key={line.id} line={line} live={i === reading} where={where} restore={restore} />)}
            {thinking.length > 0 && <div className="typing-indicator" role="status"><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>{thinking.join(" & ")} {thinking.length === 1 ? "is" : "are"} thinking</div>}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
        <div className="room-notices">
        {!busy && challengeRun?.status === "running" && <div className="room-notice" role="status"><span>Your previous attempt is finishing. Its saved result will appear here.</span></div>}
        {error && <div className="room-notice" role="alert"><span>{error}</span>{!chat && <button onClick={() => { setOpening(true); setError(null); void open() }} disabled={opening || !pwa.online}><RefreshCwIcon size={14} /> Reconnect</button>}<button className="notice-dismiss" onClick={() => setError(null)} aria-label="Dismiss notification"><XIcon size={14} /></button></div>}
        {!pwa.online && <div className="room-notice"><WifiOffIcon size={14} /><span>You’re offline. You can keep writing; send when you’re back.</span></div>}
        {pwa.update && <div className="room-notice"><span>Update available.</span><button disabled={busy || listening || introOpen || opening || !!talking || pwa.updating} onClick={pwa.applyUpdate}><RefreshCwIcon size={14} />{pwa.updating ? "Updating…" : "Update"}</button></div>}
        {installHelp && <div className="room-notice" role="status"><span>In Safari, tap Share, then “Add to Home Screen”.</span><button onClick={() => setInstallHelp(false)} aria-label="Dismiss install instructions"><XIcon size={14} /></button></div>}
        </div>
        {scoreboard && (
          <footer className="composer-wrap challenge-footer challenge-start">
            <button className="confirm-button" disabled={!canChallenge} onClick={openChallenge}>Play</button>
            {savedAttempt && challengeRun.status !== "running" && <button className="saved-result-button" onClick={() => { setDismissedRun(null); setScoreboard(false) }}>View result</button>}
          </footer>
        )}
        <Composer ready={!!chat && !opening && challengeRun?.status !== "running" && (!counting || !busy)} online={pwa.online} busy={busy} speech={speech} submit={submit} stop={hush} handle={composer} recordingChanged={setRecording} reportError={setError} promptLimit={counting ? CHALLENGE_PROMPT_LIMIT : undefined} placeholder={counting ? "Your one prompt…" : undefined} />
      </section>
      {introOpen && <ChallengeIntro ready={canChallenge} play={startChallenge} dismiss={() => setIntroOpen(false)} />}
      {!introOpen && !scoreboard && !busy && !listening && challengeRun && challengeRun.status !== "running" && dismissedRun !== challengeRun.id && <ChallengeResult key={challengeRun.id} run={challengeRun} online={pwa.online} published={setChallengeRun} dismiss={() => setDismissedRun(challengeRun.id)} playAgain={openChallenge} />}
    </main>
  )
}
