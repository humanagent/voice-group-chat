"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowDownToLineIcon, EraserIcon, ListOrderedIcon, MessagesSquareIcon, RefreshCwIcon, TrophyIcon, WifiOffIcon, XIcon } from "lucide-react"
import { ChallengeResult, Scoreboard } from "@/components/challenge-score"
import { ClearRoom } from "@/components/clear-room"
import { NameGate } from "@/components/name-gate"
import { RoomTitle } from "@/components/room-title"
import { ChallengeIntro } from "@/components/challenge-intro"
import { CHALLENGE_PROMPT_LIMIT, isChallengeRun, isStanding, replies, replyWord, type ChallengeRun, type Standing } from "@/lib/challenge"
import { ChatMessage, type Line } from "@/components/chat-message"
import { Composer, type ComposerHandle } from "@/components/composer"
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ui/conversation"
import { Stage, type Phase } from "@/components/stage"
import { usePwa } from "@/hooks/use-pwa"
import { useRoomViewport } from "@/hooks/use-room-viewport"
import { isMine, playerName, readPlayer, speakerFor, writePlayer } from "@/lib/player"
import { Voice } from "@/lib/speaking"
import { roomEvents } from "@/lib/room-stream"
import { record, sampleFrames } from "@/lib/telemetry"
import type { DictationState } from "@/lib/dictation"

type Pending = { id: string; text: string; counted: boolean }

/**
 * The line before, as query parameters, or nothing.
 *
 * Long lines are left out rather than truncated: prosody needs the last breath
 * before this one, and half a sentence is worse context than none. It is an
 * improvement the server is free to ignore, so there is nothing to handle if it
 * does.
 */
const CONTEXT_CHARS = 300
function context(before: { agent: string; text: string; grant: string } | null): string {
  if (!before || before.text.length > CONTEXT_CHARS) return ""
  return `&previous=${encodeURIComponent(before.text)}&previousAgent=${encodeURIComponent(before.agent)}&previousGrant=${encodeURIComponent(before.grant)}`
}

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
  const [standing, setStanding] = useState<Standing | null>(null)
  const [scoreboard, setScoreboard] = useState(initialScoreboard)
  const [counting, setCounting] = useState(false)
  const [dismissedRun, setDismissedRun] = useState<string | null>(null)
  const [introOpen, setIntroOpen] = useState(false)
  // Asked before anything is forgotten, because what this clears belongs to
  // everybody in the room and to three agents who cannot be asked to remember
  // it again.
  const [confirmClear, setConfirmClear] = useState(false)
  // Empty until the browser is reachable: the server has no idea who is sitting
  // here, so rendering a name during SSR would hydrate into a different room.
  const [player, setPlayer] = useState("")
  // Whether storage has been read yet, which is a different question from
  // whether it held a name. Without it the server would render the question
  // "who's playing?" into every page, and a returning player would watch it
  // flash away on hydration.
  const [known, setKnown] = useState(false)
  // Asked once, and only until it is answered or waved away. The room behind it
  // is the same room: closing the ask costs nothing but the name.
  const [asking, setAsking] = useState(true)
  // Whether the ask is standing between somebody and the game they pressed. The
  // trophy needs a name and used to be disabled for the want of one, which is a
  // locked door with no sign on it; now it asks, and the answer opens the game.
  const [afterName, setAfterName] = useState(false)
  const pwa = usePwa()
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const waiting = useRef<Pending[]>([])
  const draining = useRef(false)
  const voice = useRef<Voice | null>(null)
  /**
   * The last line the room said out loud, with the signature it said it under.
   *
   * Handed to the synthesiser as context for the next one: a voice that knows
   * the sentence it is answering sounds like an answer. It travels with its own
   * grant because it is text on its way to a provider, and the rule that the
   * room only ever synthesises its own words does not get to lapse for the line
   * beside the one being spoken.
   */
  const saidBefore = useRef<{ agent: string; text: string; grant: string } | null>(null)
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
  /**
   * Sound is granted to a gesture, never to a page.
   *
   * A reply arrives seconds after the tap that asked for it, and by then there is
   * no gesture left to play it under: the context stays suspended, the phone
   * keeps the ring switch pointed at it, and three agents mouth their answers.
   * So every tap and key in the room hands the voice its permission on the way
   * past — in the capture phase, ahead of the handler that sends the prompt, and
   * free after the first one.
   */
  useEffect(() => {
    const prime = () => voice.current?.prime()
    const gestures = ["pointerdown", "keydown"] as const
    for (const gesture of gestures) window.addEventListener(gesture, prime, { capture: true, passive: true })
    return () => { for (const gesture of gestures) window.removeEventListener(gesture, prime, { capture: true }) }
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- storage exists only on the client
  useEffect(() => { setPlayer(readPlayer()); setKnown(true) }, [])
  // Every route to a name lands here — typed into the title, or typed once into
  // the scoreboard by somebody who never named the room — so the reservation on
  // agent names is checked in one place rather than at each door.
  const rename = useCallback((name: string) => {
    const claimed = name.trim() ? playerName(name, names) : ""
    if (claimed === null) return false
    setPlayer(claimed)
    writePlayer(claimed)
    // Clearing the name from the title is a decision, not an invitation to be
    // asked again in a dialog while the caret is still in the field.
    setAsking(false)
    return !!claimed
  }, [names])
  /**
   * Everything the server says about the attempt, in one place.
   *
   * A saved result and a publication arrive as ordinary JSON, and they go
   * through the same gate the streamed events pass rather than being trusted
   * for coming from our own origin. A half-formed run rendered a result dialog
   * with an empty heading and a score reading "/20"; there is no version of
   * that worth showing, so it becomes no result at all.
   */
  const remember = useCallback((data: { run?: unknown; standing?: unknown }) => {
    const run = isChallengeRun(data.run) ? data.run : null
    setChallengeRun(run)
    setStanding(isStanding(data.standing) ? data.standing : null)
    return run
  }, [])
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
            const run = remember(data)
            // A result already on the board has nothing left to say: it is not
            // shoved in front of somebody who only came back to the room.
            if (run?.submitted) setDismissedRun(run.id)
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
  }, [remember])

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
        if (response.ok) { const data = await response.json(); if (!controller.signal.aborted) remember(data) }
      }).catch(() => {})
    }, 2000)
    return () => { clearInterval(timer); controller.abort() }
  }, [busy, challengeRun?.status, remember])

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
      const response = await fetch(item.counted ? "/api/challenge" : "/api/say", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.counted ? { message: item.text, ...(player && { speaker: player }) } : { chat, message: item.text, ...(player && { speaker: player }) }), signal: controller.signal })
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
          if (spoken) voice.current?.play(event.agent, event.audio
            ? `/api/audio?path=${encodeURIComponent(event.audio)}`
            : `/api/speak?agent=${encodeURIComponent(event.agent)}&text=${encodeURIComponent(event.text)}&grant=${encodeURIComponent(event.grant)}${context(saidBefore.current)}`)
          if (event.grant) saidBefore.current = { agent: event.agent, text: event.text, grant: event.grant }
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
          if (response.ok) remember(await response.json())
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
    // The send and mic buttons are already off without a name; this is the
    // path a keyboard Enter takes, and it must refuse the same way.
    if (!player) return false
    if (challengeRun?.status === "running" || (counted && (draining.current || text.length > CHALLENGE_PROMPT_LIMIT))) return false
    const item = { id: crypto.randomUUID(), text: text.trim(), counted }
    setLines((current) => [...current, { ...item, speaker: speakerFor(player), spoken: false, animate: true, delivery: draining.current ? "queued" : "sending" }])
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

  // Nothing reaches the room until it knows who is talking. A line with no name
  // on it is the thing this whole layer spent the night learning not to send.
  const canChallenge = !opening && !!chat && !busy && !listening && pwa.online && !!player && challengeRun?.status !== "running"
  /**
   * The cup opens whenever the room could hold a round — a missing name is not
   * one of the reasons it cannot.
   *
   * A greyed trophy was the room's answer to "who are you?", and it answered a
   * question nobody had asked in a place nobody could act on. The name is still
   * required; it is now something the button collects on the way in rather than
   * a condition it silently fails.
   */
  const canOpenChallenge = !opening && !!chat && !busy && !listening && pwa.online && challengeRun?.status !== "running"

  function openChallenge() {
    if (!canOpenChallenge) return
    if (!player) { setAfterName(true); setAsking(true); return }
    setIntroOpen(true)
  }

  /** The name, then the game it was asked for. Typed into the title, it is only
   *  a name; typed on the way to the cup, it finishes the press that opened it. */
  function claimName(name: string) {
    const claimed = rename(name)
    if (claimed && afterName) setIntroOpen(true)
    setAfterName(false)
  }

  function startChallenge() {
    if (opening || !chat || busy || listening || !pwa.online || !player || challengeRun?.status === "running") return
    setIntroOpen(false)
    voice.current?.stop()
    setChallengeRun(null)
    setDismissedRun(null)
    setCounting(true)
    setError(null)
    setScoreboard(false)
    if (!composer.current?.startRecording()) setError("Voice is unavailable. You can type your prompt.")
  }

  /**
   * Forget this conversation, in the room and in all three agents.
   *
   * The transcript is the context: every agent reads the whole thing before
   * deciding whether the last line was for it, so a room that has been running
   * for a while is answering partly to things said an hour ago — and a name
   * somebody used then is a name they will still be called now. Clearing it is
   * the only way back to an empty room, which is why the action exists and why
   * it asks first.
   *
   * The server deletes the session from every agent and opens the room again,
   * so what comes back is the room as it is on a first visit rather than a
   * half-deleted one. Everything that is not the conversation — the name, the
   * board, the draft — is untouched.
   */
  async function clearRoom() {
    setConfirmClear(false)
    hush()
    setOpening(true)
    setError(null)
    try {
      const response = await fetch("/api/room", { method: "DELETE" })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        setError(data.error || "The room couldn’t be cleared. Try again in a moment.")
        setOpening(false)
        return
      }
      setLines([])
      setPhase({})
      await open()
    } catch {
      setError("The room couldn’t be cleared. Check your connection and try again.")
      setOpening(false)
    }
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
  // Armed by Play and still counting, or already delivering: one attempt, from
  // the first press to the result.
  const attempt = counting || challengeRun?.status === "running"
  const score = challengeRun?.score ?? 0

  return (
    <main className="room-page">
      <section className="room-shell" data-scoreboard={scoreboard} data-attempt={attempt} aria-label="The room" aria-busy={opening}>
        <header className="room-header">
          <div>{scoreboard ? <h1>Challenge</h1> : <RoomTitle name={player} agents={names} rename={rename} />}{status && <p className="room-status" role="status">{status}</p>}</div>
          <nav className="room-actions" aria-label="Room modes">
            <button className="icon-button" onClick={showRoom} disabled={listening} aria-label={scoreboard ? "Back to the room" : "Room mode"} aria-current={!scoreboard ? "page" : undefined} title="Room"><MessagesSquareIcon size={18} /></button>
            <button className="icon-button" onClick={openChallenge} disabled={!canOpenChallenge} aria-label="Start challenge" title="Challenge"><TrophyIcon size={18} /></button>
            {/* The counter runs from Play, next to the cup that started it, and
                for exactly as long as the attempt lasts. The score was only
                ever visible in the modal that opened the round and the one that
                closed it — between them, the game was played blind.

                Nothing fills toward anything any more: there is no number to
                reach, so the count is the whole meter. `key` on the digits is
                the tick — each new score is a new element, and it arrives in
                the room's own lilac before settling into ink. */}
            {attempt && <p className="challenge-meter" role="status" aria-label={`Challenge: ${replies(score)}`}>
              <b key={score}>{score}</b>
              <small>{replyWord(score)}</small>
            </p>}
            {/* Destructive, shared, and irreversible, so it is never the thing
                that happens on a mis-tap: the press opens the question, and
                the question has the answer on it. */}
            <button className="icon-button" onClick={() => setConfirmClear(true)} disabled={!chat || opening || busy || listening || !pwa.online || challengeRun?.status === "running"} aria-label="Clear the room" title="Clear the room"><EraserIcon size={17} /></button>
            <button className="icon-button" onClick={showScoreboard} disabled={listening} aria-label="Global scoreboard" aria-current={scoreboard ? "page" : undefined} title="Leaderboard"><ListOrderedIcon size={18} /></button>
            {!pwa.installed && (pwa.canInstall || pwa.ios) && <button className="icon-button" onClick={() => pwa.canInstall ? void pwa.install() : setInstallHelp(true)} aria-label="Install the room" title="Install the room"><ArrowDownToLineIcon size={18} /></button>}
          </nav>
        </header>
        <div className="stage-wrap"><Stage names={names} phase={phase} level={level} /></div>
        {scoreboard && <div className="challenge-lobby"><Scoreboard /></div>}
        <Conversation className="room-conversation" initial="instant" resize="instant" contextRef={scroller as React.Ref<never>} aria-label="Conversation" aria-live="polite" aria-relevant="additions">
          <ConversationContent className="transcript-content">
            {!names.length && <p className="room-empty">No agents configured.</p>}
            {lines.map((line, i) => <ChatMessage key={line.id} line={line} mine={isMine(line.speaker, player)} agent={names.includes(line.speaker)} live={i === reading} where={where} restore={restore} />)}
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
            <button className="confirm-button" disabled={!canOpenChallenge} onClick={openChallenge}>Play</button>
            {savedAttempt && challengeRun.status !== "running" && <button className="saved-result-button" onClick={() => { setDismissedRun(null); setScoreboard(false) }}>View result</button>}
          </footer>
        )}
        <Composer ready={!!chat && !opening && !!player && challengeRun?.status !== "running" && (!counting || !busy)} online={pwa.online} busy={busy} speech={speech} submit={submit} stop={hush} handle={composer} recordingChanged={setRecording} reportError={setError} promptLimit={counting ? CHALLENGE_PROMPT_LIMIT : undefined} placeholder={player ? (counting ? "Your one prompt…" : undefined) : "Add your name above to start"} />
      </section>
      {known && asking && !player && names.length > 0 && <NameGate agents={names} claim={claimName} dismiss={() => { setAsking(false); setAfterName(false) }} />}
      {introOpen && <ChallengeIntro ready={canChallenge} player={player} play={startChallenge} dismiss={() => setIntroOpen(false)} />}
      {confirmClear && <ClearRoom clear={clearRoom} dismiss={() => setConfirmClear(false)} />}
      {/* A result belongs to somebody. Without a name the room is still asking
          for one, and two dialogs on top of each other is nobody's answer. */}
      {!introOpen && !scoreboard && !busy && !listening && !!player && challengeRun && challengeRun.status !== "running" && dismissedRun !== challengeRun.id &&
        <ChallengeResult
          key={challengeRun.id} run={challengeRun} standing={standing} player={player} online={pwa.online} canPlay={canChallenge}
          published={remember} dismiss={() => setDismissedRun(challengeRun.id)}
          playAgain={startChallenge}
          showBoard={() => { setDismissedRun(challengeRun.id); showScoreboard() }}
        />}
    </main>
  )
}
