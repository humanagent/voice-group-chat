import { expect, said, test, type Page } from "../../../web/test-support/browser"

/**
 * Whether the replies are heard, which is a different question from whether
 * they are played.
 *
 * The room was silent on a phone and had no idea it was: a context nobody had
 * woken accepted every clip, scheduled it, played it to nothing and never fired
 * `ended`, so the queue behind it stopped too. Both halves are here — the tap
 * that grants permission, and what happens to a clip when the permission is
 * refused anyway.
 *
 * The audio engine is a double, because a browser test cannot hear. What it
 * asserts is the sequence the platform actually requires: wake inside a gesture,
 * say the page is playing media, and never wait forever on a context that will
 * not.
 */
const reply = "A friendly conversation continues."

/**
 * What the double saw. `starts` and `plays` label each sound by what it was: the
 * frame of silence that unlocks a route, or an actual clip. Both routes spend
 * one silence and then, if all is well, are never heard from again.
 */
type Probe = { resumes: number; silentFrames: number; starts: string[]; plays: string[]; session: string[] }
const probe = (page: Page) => page.evaluate(() => (window as typeof window & { voiceProbe: Probe }).voiceProbe)

async function room(page: Page, { wake }: { wake: boolean }) {
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "room", complete: true } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [] } }))
  await page.route("**/api/telemetry", (route) => route.fulfill({ status: 204 }))
  await page.route("**/api/say", (route) => route.fulfill({ contentType: "text/event-stream", body: [
    said("Steve", reply), { type: "done" },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") }))
  await page.route("**/api/speak?*", (route) => route.fulfill({ json: {
    audio: "AA==", chars: Array.from(reply), starts: Array.from(reply, (_, index) => index / 20),
  } }))
  await page.addInitScript(({ wake }: { wake: boolean }) => {
    const readings: Probe = { resumes: 0, silentFrames: 0, starts: [], plays: [], session: [] }
    Object.assign(window, { voiceProbe: readings })
    // What the phone is told this page is for, recorded in order.
    let category = "auto"
    Object.defineProperty(navigator, "audioSession", {
      configurable: true,
      value: { get type() { return category }, set type(next: string) { category = next; readings.session.push(next) } },
    })
    // A context that wakes only when it is asked to, and — when `wake` is false —
    // the one this fix exists for: a context that never wakes at all.
    //
    // Only the room's own context is counted. On a touch device the speech SDK
    // opens one of its own and unlocks it from the first interaction too, and
    // counting its silence as ours would make this test about somebody else's
    // audio. The room's is the one it hangs an analyser on, in `wire`, before it
    // has made any sound at all.
    class TestContext {
      state = "suspended"
      currentTime = 0
      destination = {}
      mine = false
      async resume() { if (this.mine) readings.resumes++; if (wake) this.state = "running" }
      async decodeAudioData() { return { duration: 0.4 } }
      createBuffer() { if (this.mine) readings.silentFrames++; return { duration: 0 } }
      createAnalyser() {
        this.mine = true
        return { frequencyBinCount: 1, getByteFrequencyData: (bins: Uint8Array) => bins.fill(32), connect() {} }
      }
      createBufferSource() {
        const context = this
        const source = {
          buffer: null as null | { duration: number }, onended: null as null | (() => void), connect() {}, stop() {},
          start() {
            if (context.mine) readings.starts.push(source.buffer?.duration ? "clip" : "silence")
            setTimeout(() => source.onended?.(), 10)
          },
        }
        return source
      }
    }
    Object.defineProperty(window, "AudioContext", { configurable: true, value: TestContext })
    // The first thing any element here plays is the frame that unlocks it; the
    // element is then reused, so every later source is a real clip.
    let unlocking = ""
    HTMLMediaElement.prototype.play = function () {
      unlocking ||= this.src
      readings.plays.push(this.src === unlocking ? "silence" : "clip")
      setTimeout(() => this.dispatchEvent(new Event("ended")), 10)
      return Promise.resolve()
    }
  }, { wake })
  await page.goto("/")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
}

test("a tap is what makes the room audible, and it takes only the first one", async ({ page }) => {
  await room(page, { wake: true })
  // Nothing has been touched, so nothing has been asked for: no context woken,
  // no silent frame spent, nothing claimed about what this page plays.
  expect(await probe(page)).toMatchObject({ resumes: 0, silentFrames: 0, session: [] })

  const input = page.getByRole("textbox", { name: "Message the room" })
  await input.click()
  const primed = await probe(page)
  // Woken inside the gesture, with both routes out of here having now made a
  // sound while a finger was down. The audio session is deliberately untouched:
  // this same tap happens on the button that ends a recording, and claiming
  // playback there would take the microphone away.
  expect(primed.resumes).toBeGreaterThan(0)
  expect(primed.silentFrames).toBe(1)
  expect(primed.plays).toEqual(["silence"])
  expect(primed.session).toEqual([])

  await input.fill("Steve, say something.")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.getByRole("article", { name: "Steve said" })).toBeVisible()
  await expect.poll(async () => (await probe(page)).starts).toEqual(["silence", "clip"])
  const spoken = await probe(page)
  // Claimed here instead, one moment before the sound: this is what a ring
  // switch on silent would otherwise decide for the room.
  expect(spoken.session).toEqual(["playback"])
  // One unlocking frame each, then the reply itself through the analyser: the
  // orb and the read-along line both depend on it being this path, so the
  // element is never asked for anything but its own unlocking silence.
  expect(spoken.silentFrames).toBe(1)
  expect(spoken.plays).toEqual(["silence"])
})

test("a context that will not wake still speaks, and never wedges the queue", async ({ page }) => {
  await room(page, { wake: false })
  const input = page.getByRole("textbox", { name: "Message the room" })
  for (const line of ["Steve, say something.", "Steve, say it again."]) {
    await input.fill(line)
    await page.getByRole("button", { name: "Send message", exact: true }).click()
    await expect(page.getByRole("article", { name: "Steve said" }).last()).toBeVisible()
  }
  // Both replies were heard as files. The second is the one that matters: a
  // clip scheduled on a sleeping context never ends, and the reply behind it
  // used to wait for that forever.
  await expect.poll(async () => (await probe(page)).plays).toEqual(["silence", "clip", "clip"])
  const blocked = await probe(page)
  // Nothing was handed to the sleeping context beyond the frame that tried to
  // wake it, and it was asked more than once.
  expect(blocked.starts).toEqual(["silence"])
  expect(blocked.resumes).toBeGreaterThan(1)
  // And the room is not left mouthing the words: the agent finishes speaking.
  await expect(page.locator('.agent[data-phase="speaking"]')).toHaveCount(0)
})
