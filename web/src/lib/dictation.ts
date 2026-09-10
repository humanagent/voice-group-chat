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
type Dependencies = {
  token: (signal: AbortSignal, id: string) => Promise<string>
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

  /**
   * RMS per window of PCM16, straight off the wire.
   *
   * Wrapped in its own try: a meter is decoration, and decoration must never
   * cost a word. If the payload shape ever changes, the bars go flat and the
   * transcription carries on.
   */
  private measure(data: unknown): void {
    try {
      // Both shapes the SDK has used: the documented envelope, and the bare
      // string. A meter that reads neither goes flat without saying so, which
      // looks exactly like a microphone that is not hearing you.
      const encoded = typeof data === "string" ? data : (data as { audioBase64?: unknown }).audioBase64
      if (typeof encoded !== "string" || !encoded) return
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
        this.meter.push(Math.sqrt(sum / (end - start)) / 32768)
      }
      if (this.meter.length > METER_LENGTH) this.meter.splice(0, this.meter.length - METER_LENGTH)
    } catch { /* Decoration never costs a word. */ }
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
      connection.send = (data) => {
        if (!current()) return
        try { send(data) }
        catch {
          this.fail("dictation_disconnect", "Transcription disconnected. Review the recovered text before sending.")
          return
        }
        this.measure(data)
        if (!this.audioStarted) {
          this.audioStarted = true
          this.metric("dictation_audio_ready", performance.now() - this.started)
          this.activate()
        }
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
