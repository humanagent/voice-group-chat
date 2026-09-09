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

/** One recording owns one microphone and one socket. Late callbacks cannot affect a new recording. */
export class Dictation {
  private state = idleDictation
  private connection: Connection | null = null
  private request: AbortController | null = null
  private deadline: ReturnType<typeof setTimeout> | undefined
  private committed: string[] = []
  private partial = ""
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
