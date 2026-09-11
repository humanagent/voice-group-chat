/**
 * What the phone thinks this page is for.
 *
 * The room was silent on iOS, and none of the reasons were in this app's code.
 * Two of the platform's rules cost every spoken reply:
 *
 * 1. Web Audio obeys the hardware ring/silent switch. A phone in silent — which
 *    is how most phones live — plays a decoded buffer at zero volume and reports
 *    nothing wrong. The clip runs, the orb pulses, and nobody hears it.
 * 2. Nothing may make a sound until the person has touched the page, and the
 *    context has to be woken up inside that gesture rather than later.
 *
 * The first is what this file is for. `navigator.audioSession` (Safari 16.4+)
 * says what the page is doing with audio, and `playback` means "this is media
 * the person asked for" — the same category a video gets, and the one the switch
 * does not silence.
 *
 * Claimed one moment before a clip plays, and handed back the moment before the
 * microphone opens. Never earlier on either side: a page that claims playback
 * while it is recording loses the recording, and the two calls below are the
 * same one switch being thrown in opposite directions.
 *
 * Every call is guarded and optional. On a browser without the API this file
 * does nothing, which is exactly what it should do: the API's absence means the
 * platform never had the problem.
 */

type SessionType = "auto" | "playback" | "transient" | "transient-solo" | "ambient" | "play-and-record"
type WithSession = Navigator & { audioSession?: { type: SessionType } }

function session(): WithSession["audioSession"] | null {
  if (typeof navigator === "undefined") return null
  return (navigator as WithSession).audioSession ?? null
}

/** Speaking out loud, and audible with the ringer switched off. */
export function keepAudible(): void {
  try {
    const audio = session()
    if (audio && audio.type !== "playback") audio.type = "playback"
  } catch { /* An older WebKit refuses the assignment; playback was its default anyway. */ }
}

/**
 * About to listen.
 *
 * Recording under `playback` is a contradiction the platform resolves however it
 * likes, so the microphone announces itself before it opens and the next clip
 * moves the session back. Said in this order — record before capture, playback
 * before sound — the two never disagree about what the page is doing.
 */
export function expectMicrophone(): void {
  try {
    const audio = session()
    if (audio && audio.type !== "play-and-record") audio.type = "play-and-record"
  } catch { /* Capture still works; only the routing hint was refused. */ }
}
