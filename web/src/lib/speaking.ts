/**
 * One voice at a time, and the orb moves with it.
 *
 * Two things the room needs from a spoken reply: that clips do not overlap, and
 * that the orb pulses with the actual voice rather than with an animation
 * pretending to. Both come from the same place — a queue of one, and an
 * analyser on what is playing.
 *
 * Overlapping was never an option: in a group, who spoke after whom is most of
 * the meaning. The harness guarantees one speaker per turn, so this only has to
 * hold that line across turns.
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
  private element: HTMLAudioElement | null = null
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
    this.element?.pause()
    this.element = null
    this.live = null
    this.playing = false
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
   * This used to be `new Audio(url)` played immediately, and the first second
   * of every reply stuttered. A media element pulls its data on the main
   * thread, and the main thread at that exact moment is the busiest it ever
   * gets: the line lands in the transcript, the speaking orb springs from 96
   * to 228 pixels, its canvas re-renders at the new size and the other two
   * bubbles move out of the way. The audio was competing with the animation
   * that announces it.
   *
   * A decoded buffer does not compete. Once it is scheduled it belongs to the
   * audio thread, and nothing React does can starve it. Nothing is lost by
   * holding it whole: the route already buffers the entire clip server-side.
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

    if (sound?.buffer && this.context && this.analyser) {
      await this.context.resume().catch(() => {})
      const source = this.context.createBufferSource()
      source.buffer = sound.buffer
      source.connect(this.analyser)
      this.source = source
      await new Promise<void>((done) => {
        source.onended = () => done()
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
      this.live = null
      this.source = null
    } else {
      await this.fallback(sound?.bytes ?? null, clip.url)
    }

    if (era !== this.era) return
    this.onEnd(clip.agent)
    void this.next()
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

  /** No Web Audio, or a clip it would not decode. It still plays; the orb just
   *  will not move with it, and neither will the line. */
  private async fallback(bytes: ArrayBuffer | null, url: string) {
    let made = ""
    try {
      // The bytes if we got them, because the URL they came from answers JSON
      // and an audio element cannot play JSON.
      made = bytes ? URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" })) : ""
      const audio = new Audio(made || url)
      this.element = audio
      await audio.play()
      await new Promise<void>((done) => {
        audio.onended = () => done()
        // A clip that will not load must not strand the room in "speaking".
        audio.onerror = () => done()
      })
    } catch {
      // Autoplay refused, or the file is gone. The line is already on screen.
    }
    if (made) URL.revokeObjectURL(made)
    this.element = null
  }
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
