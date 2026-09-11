import { keepAudible } from "./audio-session"
import { record } from "./telemetry"

/**
 * One voice at a time, and the orb moves with it.
 *
 * Two things the room needs from a spoken reply: that clips never overlap, and
 * that the orb pulses with the actual voice rather than an animation pretending
 * to. Both come from the same place — a queue of one, and an analyser on what
 * is playing.
 *
 * In a group, who spoke after whom is most of the meaning. The harness gives
 * one speaker per turn; this holds that line across turns.
 *
 * On a phone all of that was inaudible, and the room had no idea. A browser tab
 * may not make a sound before it has been touched, and on iOS a decoded buffer
 * is silenced by the ring switch even after it may. So sound here is a thing the
 * room asks for permission to make — once, from the first gesture, in `prime` —
 * and every path that plays says so again before it starts. What is left is the
 * failure that used to hide: a clip that cannot play now says which way it
 * failed instead of leaving the room mouthing the words.
 */
export type Speaking = { agent: string; level: () => number }

/** A clip, decoded, and where in it each character of the line is said. */
type Sound = { buffer: AudioBuffer | null; bytes: ArrayBuffer; said: string; starts: number[] }

type Clip = { agent: string; url: string; sound?: Promise<Sound | null> }

/** Where the voice is, right now, in the line it is saying. */
export type Position = { agent: string; said: string; spoken: number }

export class Voice {
  private queue: Clip[] = []
  private playing = false
  private source: AudioBufferSourceNode | null = null
  /** Bumped by `stop`, so a clip that was mid-flight when the room emptied
   *  knows not to come back. */
  private era = 0
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private bins = new Uint8Array(0)
  /** Unlocked once, then reused: iOS grants permission to an element, not to a
   *  page, so a new `Audio` per clip is a new refusal per clip. */
  private element: HTMLAudioElement | null = null
  private silence: string | null = null
  private unlocked = false
  /** Ends the wait on whatever is playing, so leaving a room never leaves the
   *  queue holding a promise nothing will resolve. */
  private ending: (() => void) | null = null
  /** The line being said, its character timings, and the clock reading when it
   *  started. Together they are the answer to "how much of this has been
   *  spoken", which is what the transcript follows. */
  private live: { agent: string; said: string; starts: number[]; from: number } | null = null

  constructor(
    private onStart: (agent: string) => void,
    private onEnd: (agent: string) => void,
  ) {}

  /** Loudness right now, 0..1, for the orb to move with. */
  level = (): number => {
    if (!this.analyser) return 0
    this.analyser.getByteFrequencyData(this.bins as Uint8Array<ArrayBuffer>)
    let sum = 0
    for (const v of this.bins) sum += v
    // Room-mean-ish rather than peak: a peak makes the orb twitch on consonants,
    // and what should show is that somebody is talking.
    return Math.min(1, sum / this.bins.length / 128)
  }

  /**
   * How far the voice has got, in characters of the line.
   *
   * Read every frame by whoever is drawing the line, so it is arithmetic on
   * numbers already in hand and never a search: the clock says how long it has
   * been talking, and the timings say which character that is. Null when
   * nothing is being said, which is most of the time.
   */
  saying = (): Position | null => {
    const live = this.live
    if (!live || !this.context) return null
    const at = this.context.currentTime - live.from
    // A walk from the end, because the answer is almost always near where it
    // was a frame ago and the lines are two sentences long.
    let spoken = live.starts.length
    while (spoken > 0 && live.starts[spoken - 1] > at) spoken -= 1
    return { agent: live.agent, said: live.said, spoken }
  }

  /**
   * Permission to make a sound, taken from the gesture that grants it.
   *
   * Every browser refuses audio to a page nobody has touched, and the refusal is
   * silent: a context created outside a gesture starts suspended, `resume()`
   * outside one is ignored, and a buffer scheduled on it plays to nothing — no
   * error, no `ended`, and a queue that waits forever for a clip that never
   * ran. That is what a room full of agents mouthing their replies was.
   *
   * The window a gesture opens is the gesture itself, so this has to be called
   * from inside one and there is nothing to wait for afterwards. It wakes the
   * context and spends a frame of silence on both routes out — the context and
   * the element — because each is granted permission only by having made a sound
   * while the finger was still down.
   *
   * What it deliberately does NOT do is claim the audio session. Every tap in
   * the room comes through here, including the ones that end a recording, and
   * telling the phone this page is playing media while its microphone is open is
   * how you take the microphone away. The claim belongs to the moment a clip
   * actually plays, which is where it is made.
   *
   * Cheap and idempotent: after the first gesture this is a state check.
   */
  prime = (): void => {
    const context = this.wire()
    if (!context) return
    void context.resume().catch(() => {})
    if (this.unlocked) return
    this.unlocked = true
    try {
      const source = context.createBufferSource()
      source.buffer = context.createBuffer(1, 1, 22_050)
      source.connect(context.destination)
      source.start()
    } catch { /* A context with no `createBuffer` is a test double, and needs no unlocking. */ }
    this.open()
    record("voice_ready", 1)
  }

  play(agent: string, url: string) {
    this.queue.push({ agent, url })
    this.warm()
    if (!this.playing) void this.next()
  }

  /** Nothing half-played survives leaving a room. */
  stop() {
    this.era += 1
    this.queue = []
    try {
      this.source?.stop()
    } catch {
      // Already finished. Stopping a stopped source throws and means nothing.
    }
    this.source = null
    // Paused, never discarded. The permission to play belongs to this element,
    // and throwing it away means asking for it again on a page that can no
    // longer be granted it.
    this.element?.pause()
    this.live = null
    this.playing = false
    const ending = this.ending
    this.ending = null
    ending?.()
  }

  /**
   * Fetch and decode what is coming, while something else is playing.
   *
   * Two ahead, because the gap between one agent finishing and the next
   * starting should be the conversation's pause and not the network's.
   */
  private warm() {
    for (const clip of this.queue.slice(0, 2)) clip.sound ??= this.load(clip.url)
  }

  /**
   * The whole clip, decoded, before a sound comes out.
   *
   * A media element pulls its data on the main thread, and the main thread at
   * the moment a reply lands is the busiest it ever gets — the line enters the
   * transcript, the orb grows and re-renders, the other bubbles move aside.
   * Audio played that way competes with the animation announcing it, and the
   * first second stutters.
   *
   * A decoded buffer does not compete: once scheduled it belongs to the audio
   * thread, and nothing React does can starve it. Nothing is lost by holding it
   * whole, since the route buffers the entire clip server-side anyway.
   */
  private async load(url: string): Promise<Sound | null> {
    try {
      const res = await fetch(url)
      if (!res.ok) return null

      // Two kinds of sound arrive here. A reply the room asked to have spoken
      // comes back as JSON with its timings; a file an agent attached itself is
      // just a file, and plays with no idea where it is.
      let bytes: ArrayBuffer
      let said = ""
      let starts: number[] = []
      if (res.headers.get("Content-Type")?.includes("json")) {
        const clip = (await res.json()) as {
          audio?: string
          chars?: string[]
          starts?: number[]
        }
        if (!clip.audio) return null
        bytes = bytesOf(clip.audio)
        said = (clip.chars ?? []).join("")
        starts = clip.starts ?? []
      } else {
        bytes = await res.arrayBuffer()
      }

      const context = this.wire()
      // `slice()` because decoding takes the buffer with it, and the fallback
      // may still need the bytes to make a file out of.
      const buffer = context ? await context.decodeAudioData(bytes.slice(0)) : null
      return { buffer, bytes, said, starts }
    } catch {
      // Unreachable, unplayable, or a browser without Web Audio. The fallback
      // still gets a chance, and the line is already on screen either way.
      return null
    }
  }

  private async next() {
    const clip = this.queue.shift()
    if (!clip) {
      this.playing = false
      return
    }
    this.playing = true
    const era = this.era

    const sound = await (clip.sound ?? this.load(clip.url))
    if (era !== this.era) return
    this.warm()

    // Said, then heard — in that order, and as close together as they can be.
    // The orb turns to face you at the moment the sound exists rather than at
    // the moment it was asked for.
    this.onStart(clip.agent)

    keepAudible()
    if (sound?.buffer && this.context && this.analyser && await this.awake()) {
      record("voice_played", 1)
      const buffer = sound.buffer
      const source = this.context.createBufferSource()
      source.buffer = buffer
      source.connect(this.analyser)
      this.source = source
      await new Promise<void>((done) => {
        let guard: ReturnType<typeof setTimeout> | undefined
        const finish = () => { clearTimeout(guard); done() }
        // Three ways out of a clip, and the room needs all of them. It ends, the
        // room is emptied under it, or the audio thread walks off with it — a
        // page backgrounded mid-sentence never fires `ended`, and every reply
        // after it would queue behind a clip that finished minutes ago.
        if (Number.isFinite(buffer.duration)) guard = setTimeout(finish, buffer.duration * 1000 + 4000)
        this.ending = finish
        source.onended = finish
        source.start()
        // Started, so the clock has a zero. Set after `start` and not before:
        // the reading it takes here is the one the audio thread will use.
        this.live = {
          agent: clip.agent,
          said: sound.said,
          starts: sound.starts,
          from: this.context!.currentTime,
        }
      })
      this.ending = null
      this.live = null
      this.source = null
    } else {
      await this.fallback(sound?.bytes ?? null, clip.url)
    }

    if (era !== this.era) return
    this.onEnd(clip.agent)
    void this.next()
  }

  /**
   * Whether the context will actually play what it is handed.
   *
   * A suspended context accepts a buffer, schedules it, and plays it to nobody.
   * `resume()` fixes that when the page has been touched and does nothing at all
   * when it has not, which is why this asks afterwards rather than assuming. The
   * answer decides between a voice with an orb behind it and a voice at all.
   *
   * A double with no `state` is treated as awake: the property is how a real
   * context says it is not, and inventing a refusal for a test's silent context
   * would send every browser test down the fallback.
   */
  private async awake(): Promise<boolean> {
    const context = this.context
    if (!context) return false
    try { await context.resume() } catch { /* Refused outside a gesture; `state` says so below. */ }
    if (context.state !== "suspended") return true
    // Diagnosable rather than mysterious: the room is silent, and this is the
    // reason it is silent, in the same panel as everything else that is timed.
    record("voice_blocked", 1)
    return false
  }

  /** One context and one analyser for the life of the room. */
  private wire(): AudioContext | null {
    try {
      this.context ??= new AudioContext()
      if (!this.analyser) {
        this.analyser = this.context.createAnalyser()
        this.analyser.fftSize = 256
        this.analyser.smoothingTimeConstant = 0.8
        this.bins = new Uint8Array(this.analyser.frequencyBinCount)
        this.analyser.connect(this.context.destination)
      }
      return this.context
    } catch {
      return null
    }
  }

  /**
   * The route out of every reason the good one failed.
   *
   * No Web Audio, a clip it would not decode, or a context the platform will not
   * wake. An element is the more forgiving of the two on a phone: it is media
   * rather than synthesis, so iOS lets it past the ring switch, and it needs
   * permission once instead of continuously. The orb will not move with it and
   * neither will the line, which is the whole price — and a room that is heard
   * and still beats a room that is watched.
   */
  private async fallback(bytes: ArrayBuffer | null, url: string) {
    let made = ""
    try {
      keepAudible()
      // The bytes if we got them, because the URL they came from answers JSON
      // and an audio element cannot play JSON.
      made = bytes ? URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" })) : ""
      const audio = this.element ??= new Audio()
      audio.src = made || url
      record("voice_fallback", 1)
      await audio.play()
      await new Promise<void>((done) => {
        const finish = () => { audio.onended = null; audio.onerror = null; done() }
        this.ending = finish
        audio.onended = finish
        // A clip that will not load must not strand the room in "speaking".
        audio.onerror = finish
      })
      this.ending = null
    } catch {
      // Refused, or the file is gone. The line is already on screen, and the
      // panel now carries the reason nothing was heard.
      record("speech_error", 1)
    }
    if (made) URL.revokeObjectURL(made)
  }

  /**
   * A frame of nothing, played on purpose.
   *
   * An element that has never played is an element iOS will refuse later, and
   * "later" is a reply arriving over the network — as far from a finger as a
   * moment gets. So it plays silence now, while the gesture is still live, and
   * from then on it is an element that has played and may play again.
   */
  private open() {
    try {
      const audio = this.element ??= new Audio()
      audio.preload = "auto"
      audio.src = this.silence ??= URL.createObjectURL(new Blob([quiet()], { type: "audio/wav" }))
      // Paused again only if it is still the silence: a reply that arrives in
      // the meantime owns this element, and pausing that would be the bug this
      // whole file is about.
      void audio.play().then(() => {
        if (audio.src !== this.silence) return
        audio.pause()
        audio.currentTime = 0
      }).catch(() => {})
    } catch { /* No media element here, which the analyser path does not need. */ }
  }
}

/**
 * One silent frame of WAV, header and all.
 *
 * Written out rather than pasted in as base64 so it can be read: 44 bytes of
 * PCM header saying one 8kHz mono 16-bit channel, then one sample of zero. The
 * shortest true sound a media element will accept, which is all it takes to
 * turn a refusal into a permission.
 */
function quiet(): ArrayBuffer {
  const bytes = new ArrayBuffer(46)
  const view = new DataView(bytes)
  const ascii = (at: number, text: string) => [...text].forEach((letter, i) => view.setUint8(at + i, letter.charCodeAt(0)))
  ascii(0, "RIFF")
  view.setUint32(4, 38, true)
  ascii(8, "WAVEfmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true)
  view.setUint32(28, 16_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, 2, true)
  return bytes
}

/** Base64 to bytes. `atob` gives a string of char codes and nothing else will
 *  take it. */
function bytesOf(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/**
 * How much of a written line has been said out loud.
 *
 * The two strings are not the same string. The voice is given the line with its
 * emoji taken out and its spaces tidied, so a count of characters into what was
 * SAID has to be walked back onto what is WRITTEN, one character at a time,
 * skipping whatever only one of them has.
 *
 * Snapped forward to the end of the word. A boundary that lands mid-word paints
 * half of "rollback" and reads as a rendering fault; a word that goes to full
 * ink as it begins to be said reads as somebody reading aloud.
 */
export function upTo(written: string, said: string, spoken: number): number {
  if (!said) return written.length
  if (spoken <= 0) return 0
  if (spoken >= said.length) return written.length

  let at = 0
  let heard = 0
  while (at < written.length && heard < spoken) {
    if (written[at] === said[heard]) heard += 1
    at += 1
  }
  // Nothing matched: the two strings have nothing to do with each other, and
  // guessing a boundary is worse than showing the line whole.
  if (!heard) return written.length
  while (at < written.length && !/\s/.test(written[at])) at += 1
  return at
}
