"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowDownToLineIcon, EraserIcon, LoaderCircleIcon, RefreshCwIcon, Volume2Icon, VolumeXIcon, WifiOffIcon, XIcon } from "lucide-react"
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

type Pending = { id: string; text: string }

export function Room({ names, speech }: { names: string[]; speech: boolean }) {
  useRoomViewport()
  const [chat, setChat] = useState<string | null>(null)
  const [opening, setOpening] = useState(names.length > 0)
  const [clearing, setClearing] = useState(false)
  const [phase, setPhase] = useState<Record<string, Phase>>({})
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const [recording, setRecording] = useState<DictationState["status"]>("idle")
  const listening = recording !== "idle"
  const [muted, setMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installHelp, setInstallHelp] = useState(false)
  const pwa = usePwa()
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const waiting = useRef<Pending[]>([])
  const draining = useRef(false)
  const voice = useRef<Voice | null>(null)
  const round = useRef<AbortController | null>(null)
  const opener = useRef<AbortController | null>(null)
  const composer = useRef<ComposerHandle | null>(null)
  const confirmClear = useRef<HTMLDialogElement>(null)
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

  useEffect(() => { speechEnabled.current = speech && !muted }, [speech, muted])
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
    delivery(item.id, "sending")
    try {
      const response = await fetch("/api/say", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat, message: item.text }), signal: controller.signal })
      for await (const event of roomEvents(response)) {
        delivery(item.id, "sent")
        if (event.type === "thinking") show(event.agent, "thinking")
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
    } finally { if (round.current === controller) round.current = null }
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

  function submit(text: string) {
    if (!chat || opening || clearing || !navigator.onLine || !text.trim()) return false
    const item = { id: crypto.randomUUID(), text: text.trim() }
    setLines((current) => [...current, { ...item, speaker: "you", spoken: false, animate: true, delivery: draining.current ? "queued" : "sending" }])
    setError(null)
    waiting.current.push(item)
    scroller.current?.scrollToBottom({ animation: "instant", wait: true })
    void drain()
    return true
  }

  async function clear() {
    confirmClear.current?.close()
    if (busy || clearing) return
    setClearing(true)
    hush()
    try {
      const response = await fetch("/api/room", { method: "DELETE" })
      const data = await response.json()
      if (!response.ok) throw new Error("The room couldn’t be cleared. Try again in a moment.")
      setLines([])
      setError(data.complete ? null : "One agent is unavailable and may still remember the previous conversation.")
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Couldn’t clear the room.") }
    finally { setClearing(false) }
  }

  const talking = names.find((name) => phase[name] === "speaking")
  const reading = talking ? lines.findLastIndex((line) => line.speaker === talking) : -1
  const thinking = names.filter((name) => phase[name] === "thinking")
  const status = !pwa.online ? "Offline" : opening ? "Connecting…" : clearing ? "Clearing…" : !chat ? "Disconnected"
    : recording === "connecting" ? "Connecting microphone…" : recording === "finishing" ? "Finishing transcription…"
    : listening ? "Recording…" : busy ? "Responding…" : null

  return (
    <main className="room-page">
      <section className="room-shell" aria-label="The room" aria-busy={opening || clearing}>
        <header className="room-header">
          <div><h1>The room</h1>{status && <p className="room-status" role="status">{status}</p>}</div>
          <div className="room-actions">
            {!pwa.installed && (pwa.canInstall || pwa.ios) && <button className="icon-button" onClick={() => pwa.canInstall ? void pwa.install() : setInstallHelp(true)} aria-label="Install the room" title="Install the room"><ArrowDownToLineIcon size={18} /></button>}
            <button className="icon-button" disabled={!speech} onClick={() => { if (!muted) { voice.current?.stop(); setPhase({}) }; setMuted(!muted) }} aria-label={muted ? "Enable voice replies" : "Mute voice replies"} aria-pressed={muted} title={speech ? muted ? "Enable voice replies" : "Mute voice replies" : "Voice is not configured"}>{muted || !speech ? <VolumeXIcon size={18} /> : <Volume2Icon size={18} />}</button>
            <button className="icon-button" onClick={() => confirmClear.current?.showModal()} disabled={!lines.length || busy || opening || clearing || !pwa.online || listening} aria-label="Clear the room" title="Clear the room"><EraserIcon size={18} /></button>
          </div>
        </header>
        <div className="stage-wrap"><Stage names={names} phase={phase} level={level} /></div>
        <Conversation className="room-conversation" initial="instant" resize="instant" contextRef={scroller as React.Ref<never>} aria-label="Conversation" aria-live="polite" aria-relevant="additions">
          <ConversationContent className="transcript-content">
            {!names.length && <p className="room-empty">No agents configured.</p>}
            {lines.map((line, i) => <ChatMessage key={line.id} line={line} live={i === reading} where={where} restore={restore} />)}
            {thinking.length > 0 && <div className="typing-indicator" role="status"><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>{thinking.join(" & ")} {thinking.length === 1 ? "is" : "are"} thinking</div>}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
        <div className="room-notices">
        {error && <div className="room-notice" role="alert"><span>{error}</span>{!chat && <button onClick={() => { setOpening(true); setError(null); void open() }} disabled={opening || !pwa.online}><RefreshCwIcon size={14} /> Reconnect</button>}<button className="notice-dismiss" onClick={() => setError(null)} aria-label="Dismiss notification"><XIcon size={14} /></button></div>}
        {!pwa.online && <div className="room-notice"><WifiOffIcon size={14} /><span>You’re offline. You can keep writing; send when you’re back.</span></div>}
        {pwa.update && <div className="room-notice"><span>Update available.</span><button disabled={busy || listening || opening || clearing || !!talking || pwa.updating} onClick={pwa.applyUpdate}><RefreshCwIcon size={14} />{pwa.updating ? "Updating…" : "Update"}</button></div>}
        {installHelp && <div className="room-notice" role="status"><span>In Safari, tap Share, then “Add to Home Screen”.</span><button onClick={() => setInstallHelp(false)} aria-label="Dismiss install instructions"><XIcon size={14} /></button></div>}
        </div>
        <Composer ready={!!chat && !opening && !clearing} online={pwa.online} busy={busy} speech={speech} submit={submit} stop={hush} handle={composer} recordingChanged={setRecording} reportError={setError} />
        {clearing && <div className="clearing-overlay" role="status"><LoaderCircleIcon className="animate-spin" size={24} />Clearing…</div>}
      </section>
      <dialog ref={confirmClear} className="room-dialog" aria-labelledby="clear-title"><h2 id="clear-title">Clear the room?</h2><p>This clears the shared conversation for every agent. It can’t be undone.</p><div><button onClick={() => confirmClear.current?.close()}>Keep the conversation</button><button className="confirm-button" onClick={() => void clear()}>Clear the room</button></div></dialog>
    </main>
  )
}
