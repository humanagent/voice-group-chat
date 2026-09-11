import { RealtimeEvents, type RealtimeConnection } from "@elevenlabs/client"
import type { MetricName } from "./telemetry-schema"

export type DictationState = {
  status: "idle" | "connecting" | "listening" | "finishing"
  text: string
  receivedAt: number
  id: string
}
export const idleDictation: DictationState = { status: "idle", text: "", receivedAt: 0, id: "" }
type Connection = Pick<RealtimeConnection, "on" | "send" | "mute" | "commit" | "close">
/** Whatever the connection's own `send` accepts: a chunk, held or forwarded. */
type Chunk = Parameters<Connection["send"]>[0]
type Dependencies = {
  token: (signal: AbortSignal, id: string) => Promise<string>
  /** How loud a chunk has to be before it is worth sending, 0..1, or 0 for
   *  everything. Read per chunk, because the room says what it is only once
   *  the token request has answered. */
  gate?: () => number
  connect: (token: string) => Connection
  changed: (state: DictationState) => void
  completed: (text: string) => void
  failed: (message: string, recoverableText: string) => void
  metric: (name: MetricName, value: number, id: string) => void
}

const CONNECT_TIMEOUT_MS = 15_000
const FINALIZE_TIMEOUT_MS = 6000
const FLUSH_AUDIO_CHUNKS = 2
// One loudness reading per this many samples. The SDK sends ~4096 samples at a
// time, so measuring per chunk would be four bars a second — a bar chart of
// nothing. At 16kHz this is ~16ms, which is a bar you can watch a voice move.
const METER_WINDOW = 256
// About four seconds of readings. The row on screen shows the tail of it.
const METER_LENGTH = 256
/**
 * The gate's hysteresis, and its memory.
 *
 * One threshold with nothing around it chatters: a voice crosses it on every
 * syllable and the gate slams between words, so the transcriber is handed
 * confetti. Opening at the level and closing at half of it, a held moment after
 * the last loud one, is what turns a threshold into a door.
 *
 * `PRE_ROLL` is why the first word survives. Speech starts quietly — the breath
 * and the consonant are under the level that the vowel will cross — so the
 * chunks from just before the gate opened are kept and sent with it. Two of
 * them is about half a second at the SDK's chunk size.
 */
const GATE_HOLD_MS = 700
const GATE_CLOSE_RATIO = 0.5
const PRE_ROLL = 2

/** One recording owns one microphone and one socket. Late callbacks cannot affect a new recording. */
export class Dictation {
  private state = idleDictation
  private connection: Connection | null = null
  private request: AbortController | null = null
  private deadline: ReturnType<typeof setTimeout> | undefined
  private committed: string[] = []
  private partial = ""
  /** Recent loudness, oldest first. Presentation only; never a word of content. */
  private meter: number[] = []
  private started = 0
  private ready = false
  private audioStarted = false
  private firstText = false
  private lastUpdate: number | null = null
  private maxGap = 0
  private updates = 0
  private revisions = 0
  private finishingAt = 0
  private flushChunks = 0
  private commitRequested = false
  /** While this is in the future the gate is open. */
  private openUntil = 0
  /** The moments just before the gate opened, kept so the word that opened it
   *  arrives whole. */
  private preRoll: Chunk[] = []

  constructor(private deps: Dependencies) {}

  private metric(name: MetricName, value: number) { this.deps.metric(name, value, this.state.id) }
  /**
   * How loud the last few moments were, oldest first.
   *
   * Taken from the audio actually being sent, in the one place every chunk
   * already passes through, rather than from a second microphone tap: a meter
   * that reads a different stream than the one being transcribed can disagree
   * with it, and the disagreement is invisible until somebody is talking to a
   * flat line.
   */
  levels(): readonly number[] {
    return this.meter
  }

  /** The level a moment has to reach to be sent, for anybody drawing the meter:
   *  a row of bars that does not show where the gate is looks broken when the
   *  quiet ones change nothing. */
  gate(): number {
    return this.deps.gate?.() ?? 0
  }

  /**
   * RMS per window of PCM16, straight off the wire, and the loudest of them.
   *
   * Wrapped in its own try: a meter is decoration, and decoration must never
   * cost a word. If the payload shape ever changes, the bars go flat, the gate
   * opens (a measurement nobody could take is not evidence of silence) and the
   * transcription carries on.
   */
  private measure(data: unknown): number {
    let loudest = 0
    try {
      // Both shapes the SDK has used: the documented envelope, and the bare
      // string. A meter that reads neither goes flat without saying so, which
      // looks exactly like a microphone that is not hearing you.
      const encoded = typeof data === "string" ? data : (data as { audioBase64?: unknown }).audioBase64
      if (typeof encoded !== "string" || !encoded) return 1
      const pcm = atob(encoded)
      const samples = pcm.length >> 1
      for (let start = 0; start < samples; start += METER_WINDOW) {
        const end = Math.min(start + METER_WINDOW, samples)
        let sum = 0
        for (let i = start; i < end; i++) {
          // Little-endian, sign-extended from 16 bits.
          const value = (((pcm.charCodeAt(i * 2 + 1) << 8) | pcm.charCodeAt(i * 2)) << 16) >> 16
          sum += value * value
        }
        const level = Math.sqrt(sum / (end - start)) / 32768
        loudest = Math.max(loudest, level)
        this.meter.push(level)
      }
      if (this.meter.length > METER_LENGTH) this.meter.splice(0, this.meter.length - METER_LENGTH)
    } catch {
      // Decoration never costs a word — and neither does the gate: a moment
      // nobody could measure goes to the transcriber rather than being called
      // silent on the strength of a failed measurement.
      return 1
    }
    return loudest
  }

  /**
   * Whether this moment is somebody talking to the room.
   *
   * The room answers out loud, so on a phone the microphone hears the agents
   * through the speaker along with everything else in the room, and a
   * transcriber has no opinion about which of those it was meant to write down.
   * This one does: under the level, the audio is measured for the meter and
   * then dropped, and a chunk that never leaves the browser cannot be
   * transcribed, charged for, or mistaken for a word.
   *
   * Wide open while finishing. A commit waits for the capture buffer to drain
   * past `mute()`, and a gate that held the tail shut would hold the sentence
   * with it.
   */
  private passes(level: number, now: number): boolean {
    const gate = this.deps.gate?.() ?? 0
    if (gate <= 0 || this.state.status === "finishing") return true
    if (level >= gate) {
      this.openUntil = now + GATE_HOLD_MS
      return true
    }
    // Quieter, but not yet quiet: a held opening rides through the gaps inside
    // a sentence instead of cutting it into pieces.
    if (now < this.openUntil && level >= gate * GATE_CLOSE_RATIO) return true
    return now < this.openUntil
  }

  private publish() { this.deps.changed({ ...this.state }) }
  private activate() {
    if (!this.ready || !this.audioStarted || this.state.status !== "connecting") return
    clearTimeout(this.deadline)
    this.metric("dictation_ready", performance.now() - this.started)
    this.state.status = "listening"
    this.publish()
  }

  async start() {
    if (this.state.status !== "idle") return
    const request = new AbortController()
    this.request = request
    this.state = { ...idleDictation, status: "connecting", id: crypto.randomUUID() }
    this.committed = []
    this.partial = ""
    this.meter = []
    this.ready = false
    this.audioStarted = false
    this.firstText = false
    this.lastUpdate = null
    this.maxGap = 0
    this.updates = 0
    this.revisions = 0
    this.flushChunks = 0
    this.commitRequested = false
    this.openUntil = 0
    this.preRoll = []
    this.started = performance.now()
    this.metric("dictation_start", 1)
    this.publish()
    this.deadline = setTimeout(() => {
      this.fail("dictation_connect_timeout", "The microphone took too long to connect. Check its permission and try again.")
    }, CONNECT_TIMEOUT_MS)
    try {
      const token = await this.deps.token(request.signal, this.state.id)
      if (request.signal.aborted) return
      this.metric("dictation_token", performance.now() - this.started)
      const connection = this.deps.connect(token)
      this.connection = connection
      const current = () => this.connection === connection && !request.signal.aborted
      // Session-start means the server accepted the session, not that the
      // browser is sending anything: permission, the AudioContext and the
      // worklet resolve separately. The SDK has no event for the first audio
      // frame, so this watches the send boundary — never the payload — and the
      // same count decides when the capture buffer has drained past `mute()`.
      // See "A gap in the realtime SDK" in the README.
      const send = connection.send.bind(connection)
      const forward = (data: Chunk) => {
        try { send(data); return true }
        catch {
          this.fail("dictation_disconnect", "Transcription disconnected. Review the recovered text before sending.")
          return false
        }
      }
      connection.send = (data) => {
        if (!current()) return
        const level = this.measure(data)
        // Before the gate, always: this says the browser is capturing, which is
        // true whether or not the room decides the moment is worth sending. A
        // microphone that reads "connecting" until you shout is a broken one.
        if (!this.audioStarted) {
          this.audioStarted = true
          this.metric("dictation_audio_ready", performance.now() - this.started)
          this.activate()
        }
        const now = performance.now()
        if (!this.passes(level, now)) {
          // Kept, not dropped: this is the half-second the next word starts in.
          this.preRoll.push(data)
          if (this.preRoll.length > PRE_ROLL) this.preRoll.shift()
          return
        }
        const waiting = this.preRoll
        this.preRoll = []
        for (const held of waiting) if (!forward(held)) return
        if (!forward(data)) return
        // The SDK batches 4096 samples at 16kHz (~256ms). After muting, let
        // the partial capture buffer and one silence buffer pass before commit.
        if (this.state.status === "finishing" && !this.commitRequested && ++this.flushChunks >= FLUSH_AUDIO_CHUNKS) {
          this.commitRequested = true
          try { connection.commit() }
          catch { this.fail("dictation_error", "The recording couldn’t finish. Review the recovered text before sending.") }
        }
      }
      connection.on(RealtimeEvents.SESSION_STARTED, () => {
        if (!current()) return
        this.ready = true
        this.metric("dictation_session", performance.now() - this.started)
        this.activate()
      })
      const partial = ({ text }: { text: string }) => {
        if (!current()) return
        if (this.partial && !text.startsWith(this.partial)) this.revisions++
        this.partial = text
        this.update()
      }
      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, partial)
      // A final segment before commit replaces the partial; it is not another segment.
      connection.on(RealtimeEvents.FINAL_TRANSCRIPT, partial)
      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, ({ text }) => {
        if (!current()) return
        if (text.trim()) this.committed.push(text.trim())
        this.partial = ""
        this.update()
        if (this.state.status === "finishing" && this.commitRequested) {
          const result = this.state.text
          this.metric("dictation_finalize", performance.now() - this.finishingAt)
          this.metric("dictation_complete", 1)
          this.release()
          this.deps.completed(result)
        }
      })
      connection.on(RealtimeEvents.ERROR, () => {
        if (current()) this.fail("dictation_error", "Transcription stopped. Check your microphone or connection; any received text is saved in your draft.")
      })
      connection.on(RealtimeEvents.CLOSE, () => {
        if (current()) this.fail("dictation_disconnect", "Transcription disconnected. Review the recovered text before sending.")
      })
    } catch {
      if (!request.signal.aborted) this.fail("dictation_error", "The microphone couldn’t connect. Check its permission and try again.")
    }
  }

  private update() {
    const text = [...this.committed, this.partial.trim()].filter(Boolean).join(" ")
    if (text === this.state.text) return
    const now = performance.now()
    if (!this.firstText && text) { this.firstText = true; this.metric("dictation_first_text", now - this.started) }
    if (this.lastUpdate !== null) this.maxGap = Math.max(this.maxGap, now - this.lastUpdate)
    this.lastUpdate = now
    this.updates++
    this.state = { ...this.state, text, receivedAt: now }
    this.publish()
  }

  finish() {
    if (this.state.status !== "listening") return
    this.state.status = "finishing"
    this.finishingAt = performance.now()
    this.publish()
    this.deadline = setTimeout(() => {
      this.fail("dictation_finalize_timeout", "Final transcription timed out. Review the recovered text before sending.")
    }, FINALIZE_TIMEOUT_MS)
    try { this.connection?.mute() }
    catch { this.fail("dictation_error", "The microphone couldn’t stop cleanly. Review the recovered text before sending.") }
  }

  cancel() {
    if (this.state.status === "idle") return
    this.metric("dictation_cancel", 1)
    this.release()
  }

  private fail(name: MetricName, message: string) {
    const text = this.state.text
    this.metric(name, 1)
    this.release()
    this.deps.failed(message, text)
  }

  private release() {
    clearTimeout(this.deadline)
    this.metric("dictation_updates", this.updates)
    this.metric("dictation_revisions", this.revisions)
    if (this.updates > 1) this.metric("dictation_update_gap_max", this.maxGap)
    this.request?.abort()
    this.request = null
    const connection = this.connection
    this.connection = null
    try { connection?.close() } catch { /* Cleanup must still release UI state. */ }
    this.state = idleDictation
    this.publish()
  }
}
