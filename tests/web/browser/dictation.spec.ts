import { expect, test, type Page, type WebSocketRoute } from "../../../web/test-support/browser"

async function recording(page: Page, options: { finalize?: boolean; tokenFailure?: boolean } = {}) {
  let socket: WebSocketRoute | undefined
  let commits = 0
  const sent: string[] = []
  const telemetry: unknown[] = []
  await page.addInitScript(() => {
    const media = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    const observed = window as typeof window & { microphoneStreams: MediaStream[] }
    observed.microphoneStreams = []
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await media(constraints)
      observed.microphoneStreams.push(stream)
      return stream
    }
  })
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "test-room", complete: true } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [] } }))
  await page.route("**/api/scribe", (route) => route.fulfill({ status: options.tokenFailure ? 503 : 200, json: { token: "test-only-token" } }))
  await page.route("**/api/speak?*", (route) => route.fulfill({ status: 503, json: { error: "Mocked" } }))
  await page.route("**/api/say", (route) => {
    sent.push(route.request().postDataJSON().message)
    return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"done"}\n\n' })
  })
  await page.route("**/api/telemetry", (route) => {
    telemetry.push(...route.request().postDataJSON())
    return route.fulfill({ status: 204 })
  })
  await page.routeWebSocket(/api\.elevenlabs\.io/, (ws) => {
    socket = ws
    ws.send(JSON.stringify({ message_type: "session_started", session_id: "test-only-session" }))
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw))
      if (message.commit) {
        commits++
        if (options.finalize !== false) ws.send(JSON.stringify({ message_type: "committed_transcript", text: "Hola, estas son las últimas palabras." }))
      }
    })
  })
  await page.goto("/?perf=1")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
  await page.getByRole("button", { name: "Close performance diagnostics" }).click()
  return {
    sent, telemetry, commits: () => commits,
    event: (type: string, text: string) => socket!.send(JSON.stringify({ message_type: type, text })),
    begin: async () => {
      await page.getByRole("button", { name: "Record a voice message" }).click()
      if (!options.tokenFailure) await expect(page.getByRole("button", { name: "Send recording", exact: true })).toBeEnabled()
    },
  }
}

async function microphoneState(page: Page) {
  return page.evaluate(() => {
    const { microphoneStreams } = window as typeof window & { microphoneStreams: MediaStream[] }
    return { streams: microphoneStreams.length, tracks: microphoneStreams.flatMap((stream) => stream.getTracks().map((track) => track.readyState)) }
  })
}

test("long dictation stays readable, final words arrive before send, and diagnostics contain no content", async ({ page }, info) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const session = await recording(page)
  await session.begin()
  expect((await microphoneState(page)).streams).toBe(1)
  const transcript = page.getByRole("region", { name: "Live transcription" })
  const words = "Una prueba de transcripción suficientemente larga para cubrir varias líneas. ".repeat(8)
  session.event("partial_transcript", words)
  await expect(transcript).toContainText(words.trim())
  await expect.poll(() => transcript.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(2)
  await page.screenshot({ path: info.outputPath("live-transcription.png") })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(page.getByRole("button", { name: "Send recording", exact: true })).toBeInViewport()
  session.event("partial_transcript", "Hola, estas son")
  await expect(transcript).toHaveText("Hola, estas son")
  await page.getByRole("button", { name: "Send recording", exact: true }).click()
  await expect.poll(() => session.sent).toEqual(["Hola, estas son las últimas palabras."])
  expect(session.commits()).toBe(1)
  await expect.poll(() => microphoneState(page)).toEqual({ streams: 1, tracks: ["ended"] })
  await page.getByRole("button", { name: "Open performance diagnostics" }).click()
  await expect(page.locator(".perf-panel")).toContainText("Transcription · Finalized")
  await expect(page.locator(".perf-panel").getByText("Transcript render").locator("..")).not.toContainText("Awaiting sample")
  const downloaded = page.waitForEvent("download")
  await page.getByRole("button", { name: "Download performance report" }).click()
  const download = await downloaded
  await download.saveAs(info.outputPath("dictation-performance.json"))
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")))
  await expect.poll(() => session.telemetry.length).toBeGreaterThan(0)
  const logs = JSON.stringify(session.telemetry)
  expect(logs).toContain("dictation_complete")
  expect(logs).not.toMatch(/últimas|transcripción|test-only-token|audioBase64|test-only-session/)
  expect(errors).toEqual([])
})

test("a missing final result recovers a draft instead of silently sending stale text", async ({ page }) => {
  const session = await recording(page, { finalize: false })
  await page.getByRole("textbox", { name: "Message the room" }).fill("Existing draft")
  await session.begin()
  session.event("partial_transcript", "Text to recover")
  await expect(page.getByRole("region", { name: "Live transcription" })).toHaveText("Text to recover")
  await page.getByRole("button", { name: "Send recording", exact: true }).click()
  await expect(page.getByRole("button", { name: "Finishing transcription" })).toBeDisabled()
  await expect(page.getByRole("textbox", { name: "Message the room" })).toHaveValue("Existing draft\nText to recover", { timeout: 9000 })
  await expect(page.getByRole("region", { name: "The room", exact: true }).getByRole("alert")).toContainText("timed out")
  expect(session.sent).toEqual([])
  await expect.poll(() => microphoneState(page)).toEqual({ streams: 1, tracks: ["ended"] })
})

test("provider errors recover text; cancelling another recording releases its microphone", async ({ page }) => {
  const session = await recording(page)
  await session.begin()
  session.event("partial_transcript", "Keep these words")
  await expect(page.getByRole("region", { name: "Live transcription" })).toHaveText("Keep these words")
  session.event("quota_exceeded", "")
  await expect(page.getByRole("textbox", { name: "Message the room" })).toHaveValue("Keep these words")
  expect(session.sent).toEqual([])
  await expect.poll(() => microphoneState(page)).toEqual({ streams: 1, tracks: ["ended"] })
  await session.begin()
  await page.getByRole("button", { name: "Discard recording" }).click()
  await expect.poll(() => microphoneState(page)).toEqual({ streams: 2, tracks: ["ended", "ended"] })
  expect(session.sent).toEqual([])
})

test("token failures leave typing available and do not allocate a microphone", async ({ page }) => {
  const session = await recording(page, { tokenFailure: true })
  await session.begin()
  await expect(page.getByRole("region", { name: "The room", exact: true }).getByRole("alert")).toContainText("couldn’t connect")
  await expect(page.getByRole("textbox", { name: "Message the room" })).toBeEditable()
  expect((await microphoneState(page)).streams).toBe(0)
  expect(session.sent).toEqual([])
})
