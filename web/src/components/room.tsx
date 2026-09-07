"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { ComponentProps } from "react"
import {
  CheckIcon,
  EraserIcon,
  CopyIcon,
  MicIcon,
  SendIcon,
  XIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ui/conversation"
import { Input } from "@/components/ui/input"
import { LiveWaveform } from "@/components/ui/live-waveform"
import { Message, MessageContent } from "@/components/ui/message"
import { SoftOrb } from "@/components/soft-orb"
import { Response } from "@/components/ui/response"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { type Phase, Stage } from "@/components/stage"
import { CommitStrategy, useScribe } from "@/hooks/use-scribe"
import { worthSending } from "@/lib/listening"
import { type Position, upTo, Voice } from "@/lib/speaking"

/**
 * A line in the room. Only what was actually said.
 *
 * A turn that stayed quiet is not a line — it is a state, and the orb already
 * holds it: the agent goes still and its caption says so. Writing "Jordan
 * stayed quiet" into the transcript turns a decision not to speak into a
 * message, and three agents deciding that at once fills the room with sentences
 * nobody said. The terminal client still prints it, where there are no orbs to
 * carry it.
 */
type Line = { kind: "said"; speaker: string; text: string; spoken: boolean }
type Event =
  | { type: "thinking"; agent: string }
  | { type: "said"; agent: string; text: string; audio: string | null }
  | { type: "quiet"; agent: string }
  | { type: "failed"; agent: string; error: string }
  | { type: "done" }

/**
 * How long a phase that is a moment rather than a condition is held.
 *
 * Speaking is not in here: when there is audio it lasts exactly as long as the
 * voice does, and the fallback below only covers a reply that was never spoken.
 */
const HOLD: Partial<Record<Phase, number>> = { quiet: 1000, speaking: 2600 }

type ChatActionsProps = ComponentProps<"div">

const ChatActions = ({ className, children, ...props }: ChatActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
)

type ChatActionProps = ComponentProps<typeof Button> & {
  tooltip?: string
  label?: string
}

const ChatAction = ({
  tooltip,
  children,
  label,
  className,
  variant = "ghost",
  size = "sm",
  ...props
}: ChatActionProps) => {
  const button = (
    <Button
      className={cn(
        "text-muted-foreground hover:text-foreground relative size-9 p-1.5",
        className
      )}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  )

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return button
}

/**
 * A line, with the voice's place in it.
 *
 * The whole line is on screen from the moment it arrives — it is never held
 * back waiting for a voice that takes two seconds to synthesise, and nothing
 * here can hide it: with no sound, or once the clip ends, everything is in full
 * ink. What moves is only the weight, ahead of the reading and behind it.
 *
 * It watches the clock itself rather than being told. A speaking line changes
 * thirty times a second and there is one of them; putting that in the room's
 * state would re-render the entire transcript for a word going darker.
 *
 * And only the line being spoken watches it. `live` is false for every other
 * line in the room, which is nearly all of them, and a transcript of fifty
 * lines each holding a frame loop to report that nothing is happening is fifty
 * callbacks a frame for one word.
 */
function Reading({
  text,
  speaker,
  live,
  where,
}: {
  text: string
  speaker: string
  live: boolean
  where: () => Position | null
}) {
  const [cut, setCut] = useState(text.length)

  useEffect(() => {
    if (!live) return
    let frame = 0
    const follow = () => {
      const at = where()
      setCut(at && at.agent === speaker ? upTo(text, at.said, at.spoken) : text.length)
      frame = requestAnimationFrame(follow)
    }
    frame = requestAnimationFrame(follow)
    return () => cancelAnimationFrame(frame)
  }, [text, speaker, live, where])

  // A line nobody is reading is a line in full ink, whatever the last frame
  // happened to leave behind.
  //
  // `live` alone decides which of the two this is, and never `cut`. Swapping
  // on `cut` meant the element changed twice while one line was said — plain
  // when the voice reached it, markdown again when the voice passed the end —
  // and each swap is a remount of the paragraph you are reading.
  if (!live) {
    return (
      <Response className="w-auto [overflow-wrap:anywhere] whitespace-pre-wrap">
        {text}
      </Response>
    )
  }

  // Plain text while it is being read, because the split is a split of
  // characters and markdown is a tree. Same wrapping and same size, so the
  // swap at the end of the clip does not move a word.
  return (
    <p className="w-auto [overflow-wrap:anywhere] whitespace-pre-wrap">
      {text.slice(0, cut)}
      <span className="text-muted-foreground/45">{text.slice(cut)}</span>
    </p>
  )
}

export function Room({ names, speech }: { names: string[]; speech: boolean }) {
  const [chat, setChat] = useState<string | null>(null)
  const [opening, setOpening] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [phase, setPhase] = useState<Record<string, Phase>>({})
  const [lines, setLines] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState("")
  const [copied, setCopied] = useState<number | null>(null)
  /**
   * The microphone opens when you press it, and not before.
   *
   * It was open all the time for a while, deciding on its own when you had
   * finished a sentence. It did not work: an open microphone in a room whose
   * three agents are talking out loud hears them as well as you, and no
   * threshold separates a person from a speaker reliably enough to send what
   * it heard to three agents without being asked. Pressing is the signal that
   * the guessing was standing in for.
   */
  const [listening, setListening] = useState(false)
  const [deaf, setDeaf] = useState<string | null>(null)
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  /** Lines typed while the room was still answering the one before. */
  const waiting = useRef<string[]>([])
  const voice = useRef<Voice | null>(null)
  /** The round in flight, so talking over it can end it. */
  const round = useRef<AbortController | null>(null)
  /**
   * The transcript's own scroller.
   *
   * `StickToBottom` follows new lines only while it believes you are at the
   * bottom, and it stopped believing it: one scroll that landed a few pixels
   * short is enough to unstick it for the rest of the conversation, so an
   * agent would answer and the answer would arrive off-screen. So the room
   * asks explicitly on every line instead of hoping.
   */
  const scroller = useRef<{
    scrollToBottom: (options?: {
      animation?: "smooth" | "instant"
      ignoreEscapes?: boolean
      wait?: boolean
    }) => void
  } | null>(null)
  const box = useRef<HTMLInputElement>(null)

  /** Put an agent in a phase, and let it fall back to listening when that phase
   *  is a moment rather than a condition. */
  const show = useCallback((agent: string, next: Phase) => {
    clearTimeout(timers.current[agent])
    setPhase((p) => ({ ...p, [agent]: next }))
    const hold = HOLD[next]
    if (hold) {
      timers.current[agent] = setTimeout(
        () => setPhase((p) => (p[agent] === next ? { ...p, [agent]: "listening" } : p)),
        hold,
      )
    }
  }, [])

  useEffect(() => {
    const running = timers.current
    return () => Object.values(running).forEach(clearTimeout)
  }, [])

  /**
   * The caret starts in the box, but not with `autoFocus`.
   *
   * `autoFocus` is a server-rendered attribute, so the browser focuses the
   * input before React hydrates — and anything that reacts to focus writes to
   * the element first. One browser here stamps a `data-cmux-addressbar-focus-id`
   * on whatever is focused, React found an attribute it had not put there, and
   * the whole tree came up with a hydration mismatch.
   *
   * After mount there is nothing to mismatch: React already owns the element,
   * and whatever the browser adds next is its business.
   */
  useEffect(() => {
    box.current?.focus()
  }, [])

  /**
   * Every new line brings the transcript with it, and it arrives already there.
   *
   * Instant, not smooth, and that is the fix for a transcript that shivered.
   * The smooth scroll is a spring: it accumulates velocity towards a target
   * read from `scrollHeight`, and every one of those numbers moves while it is
   * flying. A line lands and the content grows; the reply below it grows again
   * when the voice reaches its end and the paragraph swaps back to markdown;
   * the copy button appears under it. Each change moves the target mid-flight,
   * the spring overshoots past the bottom, the library pulls it back, and with
   * three agents answering in a burst that repeats until the last line settles
   * — which is exactly what it looked like: a jitter that stops after a while.
   *
   * `ignoreEscapes` made it worse rather than better. While that animation
   * runs, every scroll event the browser reports is forced back to the previous
   * position, so the correction and the spring write the same element in the
   * same frame.
   *
   * There is nothing to animate here anyway. The transcript is pinned to the
   * bottom, the new line is what you were waiting for, and gliding a few
   * hundred pixels to reach it is the app showing you its own scrolling.
   */
  useEffect(() => {
    if (!lines.length) return
    scroller.current?.scrollToBottom({ animation: "instant", wait: true })
  }, [lines.length])

  // A reply is spoken for exactly as long as the voice lasts. The orb is the
  // one that is talking, so it holds the middle until the clip ends rather than
  // for a guessed number of seconds.
  if (!voice.current) {
    voice.current = new Voice(
      (agent) => {
        clearTimeout(timers.current[agent])
        setPhase((p) => ({ ...p, [agent]: "speaking" }))
      },
      (agent) =>
        setPhase((p) => (p[agent] === "speaking" ? { ...p, [agent]: "listening" } : p)),
    )
  }
  const level = useCallback(() => voice.current?.level() ?? 0, [])
  /** Where the voice is in the line it is saying, for the transcript to
   *  follow. Stable, so the line watching it is not re-subscribed every
   *  render. */
  const where = useCallback(() => voice.current?.saying() ?? null, [])

  /**
   * Stop the room mid-sentence.
   *
   * Reaching for the microphone while three agents are talking is not a
   * request to be queued behind them, it is an interruption — so it lands as
   * one: the voices cut, the round is dropped, and the room waits for you.
   * Whatever an agent had not said yet is lost, which is the point. It was
   * answering the line you just talked past.
   */
  const hush = useCallback(() => {
    voice.current?.stop()
    round.current?.abort()
    setPhase((p) =>
      Object.fromEntries(
        Object.entries(p).map(([name, ph]) => [
          name,
          ph === "speaking" || ph === "thinking" ? "listening" : ph,
        ]),
      ),
    )
  }, [])

  // No effect seeds the phases. An agent with no entry reads as listening
  // everywhere it is read — `phase[name] ?? "listening"`, in both places — so
  // writing that same answer into state on every change of the group was a
  // render's worth of work to say what the default already said.

  /** Everything already said in the room. Arriving where the conversation is
   *  should not look like arriving somewhere blank. */
  const catchUp = useCallback(async (id: string) => {
    try {
      const d = await (await fetch(`/api/history?chat=${encodeURIComponent(id)}`)).json()
      setLines(
        (d.lines ?? []).map((l: { speaker: string; text: string; spoken: boolean }) => ({
          kind: "said" as const,
          ...l,
        })),
      )
    } catch {
      // A history that will not load is an empty room, not a broken one.
    }
  }, [])

  // The room opens itself. There is nothing to pick and no door to go through:
  // asking for the page IS asking to be in it.
  useEffect(() => {
    let gone = false
    void (async () => {
      try {
        const d = await (await fetch("/api/room")).json()
        if (gone || !d.chat) return
        setChat(d.chat)
        await catchUp(d.chat)
      } finally {
        if (!gone) setOpening(false)
      }
    })()
    return () => {
      gone = true
    }
  }, [catchUp])

  /**
   * Empty the room, on every agent, and start again with the same people.
   *
   * There is no undo: the transcript lives in the agents' sessions and nowhere
   * in this app, so pressing this is the last time anybody can read it.
   */
  async function clear() {
    setClearing(true)
    voice.current?.stop()
    waiting.current = []
    try {
      const res = await fetch("/api/room", { method: "DELETE" })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error ?? "could not clear it")
      setLines([])
      setPhase({})
      setDeaf(d.complete ? null : "one agent did not answer — it still remembers")
    } catch (err) {
      setDeaf(err instanceof Error ? err.message : "could not clear it")
    } finally {
      setClearing(false)
    }
  }

  // Speech in, from ElevenLabs Scribe. The key stays on the server and this
  // gets a token good for one session, so nothing secret reaches the page.
  // `scribe_v2_realtime`, not the `scribe_realtime_v2` the reference block
  // passes: that id is no longer one the API accepts, and it fails as an
  // `invalid_request` close a second AFTER the socket opens, so it reads as
  // the microphone's fault rather than as a wrong parameter.
  //
  // VAD, because the alternative is manual commits, and there is nothing left
  // to press: silence is the only thing that can end a turn when the
  // microphone never closes.
  const onError = useCallback((err: Error | globalThis.Event) => {
    // Say what actually went wrong. "Could not hear you" for a rejected
    // parameter sends you looking at the microphone, which is the one thing
    // that was working.
    setDeaf(err instanceof Error ? err.message : "could not hear you")
    setListening(false)
  }, [])

  const scribe = useScribe({
    modelId: "scribe_v2_realtime",
    commitStrategy: CommitStrategy.VAD,
    // VAD still settles the segments while you hold the floor — a pause
    // mid-sentence must not strand what you said as provisional — but it no
    // longer decides anything: the button says when you started and when you
    // stopped. The gate below is only about noise, so a cough between two
    // words does not become a word.
    vadThreshold: 0.6,
    minSpeechDurationMs: 200,
    minSilenceDurationMs: 500,
    vadSilenceThresholdSecs: 0.7,
    onError,
  })

  /** What has been heard so far: the settled parts, plus the words still
   *  arriving. Both, or the last thing you said is dropped on stop. */
  const heard = useCallback(() => {
    const settled = scribe.committedTranscripts.map((s) => s.text.trim()).filter(Boolean)
    const arriving = scribe.partialTranscript.trim()
    return [...settled, arriving].filter(Boolean).join(" ")
  }, [scribe.committedTranscripts, scribe.partialTranscript])

  /**
   * Open the microphone, and take the floor.
   *
   * Pressing while the room is answering interrupts it, because that is what
   * pressing means here: you would not reach for the microphone if you were
   * still listening.
   */
  async function listen() {
    setDeaf(null)
    hush()
    scribe.clearTranscripts()
    try {
      const res = await fetch("/api/scribe", { method: "POST" })
      const { token, error } = await res.json()
      if (!token) throw new Error(error ?? "no token")
      await scribe.connect({
        token,
        microphone: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      setListening(true)
    } catch (err) {
      // A microphone the browser refused and a key the server does not have
      // are the same thing from here: speech is off, typing still works.
      setDeaf(err instanceof Error ? err.message : "could not hear you")
      scribe.disconnect()
    }
  }

  /**
   * Stop, and say it.
   *
   * Pressing stop is the same gesture as pressing enter: you are done, and the
   * room can have it. Nothing is left in the box to send a second time.
   *
   * Stopping with nothing heard says so. The first partial takes a few seconds
   * to come back, so a short thing said and stopped straight after lands here
   * with an empty transcript — and silently doing nothing looks exactly like
   * the feature is broken.
   */
  function stopListening() {
    const said = heard()
    scribe.disconnect()
    setListening(false)
    if (worthSending(said)) submit(said)
    else setDeaf("nothing came back — try again and give it a moment")
  }

  /** Let it go without saying it. */
  function discard() {
    scribe.disconnect()
    scribe.clearTranscripts()
    setListening(false)
  }

  /**
   * Say something, now or as soon as the room is free.
   *
   * Pressing enter used to disable the box until every agent had answered,
   * which took the focus with it: you typed a line, the caret vanished, and the
   * next thing you typed went nowhere. So the box is never disabled and never
   * loses the caret — type the next line while they are still answering the
   * last one.
   *
   * A second line is queued rather than sent, because a round is one streamed
   * request and two of them over the same room would interleave their turns.
   * It goes into the transcript the moment you send it, the way a message does
   * on a slow connection, and leaves for real when the round before it ends.
   */
  function submit(text: string) {
    if (!chat || !text.trim()) return
    setLines((l) => [...l, { kind: "said", speaker: "you", text, spoken: false }])
    setDraft("")
    waiting.current.push(text)
    if (!busy) void drain()
  }

  async function drain() {
    setBusy(true)
    for (let next = waiting.current.shift(); next; next = waiting.current.shift()) {
      await say(next)
    }
    setBusy(false)
  }

  async function say(text: string) {
    // The round is abortable because interrupting is part of talking. Once you
    // have spoken over it, the turns still coming down this stream are answers
    // to a line you have already moved past.
    const stop = new AbortController()
    round.current = stop

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const res = await fetch("/api/say", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat, message: text }),
        signal: stop.signal,
      })
      reader = res.body?.getReader()
    } catch {
      return
    }
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      let done: boolean
      let value: Uint8Array | undefined
      try {
        ;({ done, value } = await reader.read())
      } catch {
        // Aborted, or the connection went. Either way the round is over.
        return
      }
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split("\n\n")
      buffer = chunks.pop() ?? ""
      for (const chunk of chunks) {
        if (!chunk.startsWith("data: ")) continue
        const event: Event = JSON.parse(chunk.slice(6))
        if (event.type === "thinking") {
          show(event.agent, "thinking")
        } else if (event.type === "said") {
          // The runtime returns words; the sound is asked for here. It used to
          // arrive as a file the agent had already made, which is why the line
          // itself was two seconds late.
          //
          // `event.audio` is still honoured because an agent can attach media
          // of its own — a file it wrote and meant to send — and that is not
          // its voice.
          if (event.audio) {
            voice.current?.play(
              event.agent,
              `/api/audio?path=${encodeURIComponent(event.audio)}`,
            )
          } else if (speech) {
            voice.current?.play(
              event.agent,
              `/api/speak?agent=${encodeURIComponent(event.agent)}&text=${encodeURIComponent(event.text)}`,
            )
          } else {
            show(event.agent, "speaking")
          }
          setLines((l) => [
            ...l,
            {
              kind: "said",
              speaker: event.agent,
              text: event.text,
              spoken: speech || !!event.audio,
            },
          ])
        } else if (event.type === "quiet") {
          // The orb settles, and that is the whole report. An agent that goes
          // quiet on a relayed line has still stopped thinking.
          show(event.agent, "quiet")
        } else if (event.type === "failed") {
          show(event.agent, "unreachable")
          setLines((l) => [
            ...l,
            {
              kind: "said",
              speaker: event.agent,
              text: `did not answer — ${event.error}`,
              spoken: false,
            },
          ])
        }
      }
    }
  }

  if (!names.length) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-3 px-6">
        <h1 className="text-lg">No agents configured.</h1>
        <p className="text-muted-foreground text-sm">
          Start the group from the repo root, or set <code>GROUP_AGENTS</code> to the
          contents of <code>group.json</code>.
        </p>
      </main>
    )
  }

  /** Everything it has heard since you pressed. */
  const listened = heard()

  /**
   * The line being read out loud, if any.
   *
   * The newest one by whoever is speaking, rather than simply the newest line:
   * a reply reaches the transcript about two seconds before its voice does, so
   * the next agent's line can already be on screen while the first is still
   * being said.
   */
  const talking = names.find((n) => phase[n] === "speaking") ?? null
  const reading = talking ? lines.findLastIndex((l) => l.speaker === talking) : -1

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl items-center px-4 py-8">
      <Card className="mx-auto flex h-[min(46rem,90dvh)] w-full flex-col gap-0 overflow-hidden">
        {/* The room, wearing its own face. `voice-chat-01` puts the agent's orb
            in a ringed circle beside its name; there are three agents here and
            only one room, so the circle is the ROOM's — seeded from its id, so
            every room has an orb of its own and keeps it. */}
        <CardHeader className="flex shrink-0 flex-row items-center justify-between pb-4">
          <div className="flex items-center gap-4">
            <div className="ring-border relative size-10 shrink-0 overflow-hidden rounded-full ring-1">
              <SoftOrb name={chat ?? "room"} className="h-full w-full" />
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              {/* Not a button any more. There is one room, so its name is a
                  label rather than something you navigate with. */}
              <p className="truncate text-sm leading-none font-medium">The room</p>
              <div className="flex items-center gap-2">
                <p className="text-muted-foreground truncate text-xs">
                  {opening
                    ? "opening…"
                    : clearing
                      ? "clearing…"
                      : listening
                        ? "listening"
                        : busy
                          ? "the room is answering"
                          : names.join(", ")}
                </p>
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {/* Where the picker used to be. Emptying the room is the only
                thing left to do to it from up here, and there is no undo:
                the transcript lives in the agents' sessions and nowhere in
                this app. */}
            <ChatAction
              tooltip={lines.length ? "Clear the room" : "Nothing to clear"}
              label="Clear the room"
              onClick={clear}
              disabled={clearing || busy || opening || !lines.length}
            >
              <EraserIcon className="size-4" />
            </ChatAction>
            {/* Where the block puts its connection light. A room is never
                connecting — it is either working or waiting. */}
            <div
              className={cn(
                "flex h-2 w-2 rounded-full transition-all duration-300",
                busy || opening || clearing
                  ? "animate-pulse bg-white/40"
                  : "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]",
              )}
            />
          </div>
        </CardHeader>

        {/* Ours, and the only thing here the block does not have: it draws one
            agent, and this is a room. Everything above and below is the block. */}
        <div className="flex h-2/5 min-h-0 shrink-0 border-b px-6 pb-6">
          <Stage names={names} phase={phase} level={level} />
        </div>

        <CardContent className="flex-1 overflow-hidden p-0">
          {/* Already at the bottom, not scrolled there — on arrival and on
              every line after. Both of these are `instant` on purpose: they
              are the same scroll asked for twice, once by the room when a line
              lands and once by the library when the content it measures grows,
              and two springs pulling one element is the shiver. Instant, they
              are the same write of the same number and cannot disagree. */}
          <Conversation
            className="h-full"
            initial="instant"
            resize="instant"
            contextRef={scroller as React.Ref<never>}
          >
            {/* `pb-6`, matching the top. At `pb-2` the last line sat two
                pixels off the border and read as cut rather than as ended —
                and the one place a transcript must not look truncated is the
                bottom, where the newest thing is. */}
            <ConversationContent className="flex min-w-0 flex-col gap-2 p-6">
              {lines.length === 0 ? (
                <ConversationEmptyState
                  icon={<SoftOrb name={chat ?? "room"} className="size-12" />}
                  title="A room with three agents in it"
                  description="Name one of them to reach them. The others decide for themselves."
                />
              ) : (
                lines.map((line, i) => (
                    <div key={i} className="flex w-full flex-col gap-1">
                      <Message from={line.speaker === "you" ? "user" : "assistant"}>
                        <MessageContent variant="flat" className="max-w-full min-w-0">
                          {line.speaker !== "you" && (
                            <span className="text-muted-foreground text-xs">
                              {line.speaker}
                              {line.spoken && " · spoken"}
                            </span>
                          )}
                          {line.speaker === "you" ? (
                            <Response className="w-auto [overflow-wrap:anywhere] whitespace-pre-wrap">
                              {line.text}
                            </Response>
                          ) : (
                            <Reading
                              text={line.text}
                              speaker={line.speaker}
                              live={i === reading}
                              where={where}
                            />
                          )}
                        </MessageContent>
                        {line.speaker !== "you" && (
                          <div className="ring-border size-6 flex-shrink-0 self-end overflow-hidden rounded-full ring-1">
                            <SoftOrb name={line.speaker} still className="h-full w-full" />
                          </div>
                        )}
                      </Message>
                      {line.speaker !== "you" && (
                        <ChatActions>
                          <ChatAction
                            size="sm"
                            tooltip={copied === i ? "Copied!" : "Copy"}
                            onClick={() => {
                              navigator.clipboard.writeText(line.text)
                              setCopied(i)
                              setTimeout(() => setCopied(null), 2000)
                            }}
                          >
                            {copied === i ? (
                              <CheckIcon className="size-4" />
                            ) : (
                              <CopyIcon className="size-4" />
                            )}
                          </ChatAction>
                        </ChatActions>
                      )}
                    </div>
                ))
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        </CardContent>

        <CardFooter className="shrink-0 flex-col items-stretch gap-1 border-t">
          <div className="flex w-full items-center gap-2">
            {listening ? (
              <>
                {/* Yourself, the whole time you hold the floor. It proves the
                    microphone is open several seconds before the first words
                    come back, which is when you need to know it. */}
                <div className="flex h-9 min-w-0 flex-1 items-center gap-3">
                  <LiveWaveform
                    active
                    height={28}
                    barWidth={3}
                    barGap={1}
                    className="w-20 shrink-0"
                  />
                  {/* And what it has understood so far, beside it. The waveform
                      says a microphone is open; it says nothing about whether
                      any of it is landing. */}
                  <p
                    className={cn(
                      "min-w-0 flex-1 truncate text-sm",
                      listened ? "text-foreground" : "text-muted-foreground italic",
                    )}
                  >
                    {listened || "listening…"}
                  </p>
                </div>
                {/* It sits where Send sits and it IS Send — pressing it ends
                    the message and hands it to the room, exactly like enter.
                    A stop square said the recording would end and left you
                    wondering what happened to the words. Discard is last, away
                    from the hand that means to keep what it said. */}
                <Button
                  onClick={stopListening}
                  size="icon"
                  variant="secondary"
                  className="shrink-0 rounded-full"
                >
                  <SendIcon className="size-4" />
                  <span className="sr-only">Send what you said</span>
                </Button>
                <Button
                  onClick={discard}
                  size="icon"
                  variant="ghost"
                  className="shrink-0 rounded-full"
                >
                  <XIcon className="size-4" />
                  <span className="sr-only">Discard what you said</span>
                </Button>
              </>
            ) : (
              <>
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault()
                      submit(draft)
                    }
                  }}
                  placeholder="Type a message..."
                  className="h-9 focus-visible:ring-0 focus-visible:ring-offset-0"
                  ref={box}
                />
                <Button
                  onClick={() => submit(draft)}
                  size="icon"
                  variant="ghost"
                  className="shrink-0 rounded-full"
                  disabled={!draft.trim()}
                >
                  <SendIcon className="size-4" />
                  <span className="sr-only">Send message</span>
                </Button>
                {/* Not disabled while the room is answering: pressing it there
                    is how you cut in. */}
                <Button
                  onClick={listen}
                  size="icon"
                  variant="ghost"
                  className="shrink-0 rounded-full"
                  disabled={!speech || scribe.status === "connecting"}
                >
                  <MicIcon className="size-4" />
                  <span className="sr-only">Hold the floor and say it</span>
                </Button>
              </>
            )}
          </div>
          {/* Said once, under the row, and never in place of the box: a
              microphone that was refused must not cost you the ability to type. */}
          {deaf && <p className="text-muted-foreground text-xs">{deaf}</p>}
        </CardFooter>
      </Card>
    </main>
  )
}
