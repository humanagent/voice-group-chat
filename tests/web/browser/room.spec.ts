import { AxeBuilder, expect, test, type Page } from "../../../web/test-support/browser"

const sse = (text = "A small first step is a good place to start.") => [
  { type: "thinking", agent: "Anna" }, { type: "said", agent: "Anna", text, audio: null },
  { type: "quiet", agent: "Jordan" }, { type: "quiet", agent: "Pepe" }, { type: "done" },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")

async function mockRoom(page: Page, lines: { speaker: string; text: string; spoken: boolean }[] = []) {
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "room", agents: ["Anna", "Jordan", "Pepe"], complete: true } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines } }))
  await page.route("**/api/speak?*", (route) => route.fulfill({ status: 503, json: { error: "Speech mocked for browser tests" } }))
  await page.route("**/api/scribe", (route) => route.fulfill({ status: 503, json: { error: "Microphone mocked for browser tests" } }))
  await page.route("**/api/say", (route) => route.fulfill({ contentType: "text/event-stream", body: sse() }))
}

test("chat, multiline drafts, IME, and real performance samples", async ({ page }, info) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await mockRoom(page)
  await page.goto("/?perf=1")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
  await page.getByRole("button", { name: "Close performance diagnostics" }).click()
  await page.screenshot({ path: info.outputPath("room-empty.png") })
  const box = page.getByRole("textbox", { name: "Message the room" })
  await box.fill("Anna, let’s explore an idea.")
  await box.press("Shift+Enter")
  await box.press("KeyA")
  await expect(box).toHaveValue("Anna, let’s explore an idea.\na")
  await box.evaluate((node) => node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })))
  await expect(page.getByText("A small first step is a good place to start.", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.getByText("A small first step is a good place to start.", { exact: true })).toBeVisible()
  await expect(box).toHaveValue("")
  await box.fill("Keep this thought for later")
  await page.reload()
  await expect(box).toHaveValue("Keep this thought for later")
  await page.getByRole("button", { name: "Close performance diagnostics" }).click()
  await box.fill("Anna, help me make this clearer.")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.getByText("A small first step is a good place to start.", { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath("room-conversation.png") })
  await page.getByRole("button", { name: "Open performance diagnostics" }).click()
  await expect(page.locator(".perf-panel").getByText("Frame interval · p95")).toBeVisible()
  await expect.poll(() => page.locator(".perf-panel").innerText()).not.toContain("Frame interval · p95\nAwaiting sample")
  await info.attach("performance-samples", { body: await page.locator(".perf-panel").innerText(), contentType: "text/plain" })
  expect(errors).toEqual([])
})

test("queued messages serialize and an interrupted stream is recoverable", async ({ page }) => {
  await mockRoom(page)
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  const sent: string[] = []
  await page.route("**/api/say", async (route) => {
    sent.push(route.request().postDataJSON().message)
    if (sent.length === 1) { await held; await route.fulfill({ contentType: "text/event-stream", body: sse() }) }
    else await route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"thinking","agent":"Anna"}\n\n' })
  })
  await page.goto("/")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
  const box = page.getByRole("textbox", { name: "Message the room" })
  await box.fill("First message")
  await box.press("Enter")
  await box.fill("Second message")
  await box.press("Enter")
  await expect(page.getByText("Queued", { exact: true })).toBeVisible()
  expect(sent).toEqual(["First message"])
  release()
  await expect(page.getByRole("region", { name: "The room", exact: true }).getByRole("alert")).toContainText("connection was interrupted")
  expect(sent).toEqual(["First message", "Second message"])
  await page.getByRole("button", { name: "Use message as draft" }).click()
  await expect(box).toHaveValue("Second message")
  await expect(page.getByRole("button", { name: "Stop the room" })).toHaveCount(0)
})

test("incoming replies respect scroll position and clear requires confirmation", async ({ page, browserName }) => {
  await mockRoom(page, Array.from({ length: 45 }, (_, i) => ({ speaker: i % 2 ? "Anna" : "you", text: `Earlier message ${i}. A thought worth keeping in view.`, spoken: false })))
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/say", async (route) => { await held; await route.fulfill({ contentType: "text/event-stream", body: sse() }) })
  await page.goto("/")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
  const box = page.getByRole("textbox", { name: "Message the room" })
  await box.fill("Anna, one more thought.")
  await box.press("Enter")
  const scroller = page.locator(".room-conversation > div").first()
  await expect(page.getByRole("article", { name: "You said" }).filter({ hasText: "Anna, one more thought." })).toBeVisible()
  // Wait for the send-triggered resize/scroll cycle before simulating a reader
  // scrolling away. Otherwise a pending ResizeObserver can consume the gesture.
  await expect.poll(() => scroller.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(5)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  if (browserName === "chromium") {
    await scroller.hover()
    await page.mouse.wheel(0, -10000)
  } else {
    // Touch WebKit has no wheel support; Firefox bounds each wheel gesture.
    await scroller.evaluate((node) => { node.scrollTop = 0 })
  }
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeLessThan(100)
  await expect(page.getByRole("button", { name: "Jump to latest messages" })).toBeVisible()
  release()
  await expect(page.getByText("A small first step is a good place to start.", { exact: true })).toBeAttached()
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeLessThan(100)
  await page.getByRole("button", { name: "Jump to latest messages" }).click()
  await expect(page.getByText("A small first step is a good place to start.", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Clear the room", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByRole("button", { name: "Keep the conversation" }).click()
  await expect(page.getByText("A small first step is a good place to start.", { exact: true })).toBeVisible()
})

test.describe("Service worker integration", () => {
test.use({ serviceWorkers: "allow" })
test("PWA offline navigation preserves drafts and never caches conversation APIs", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "Playwright service-worker network/offline instrumentation is Chromium-only")
  await mockRoom(page)
  await page.goto("/")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
  await page.evaluate(async () => { await navigator.serviceWorker.ready; if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true })) })
  await page.getByRole("textbox", { name: "Message the room" }).fill("A thought that survives offline")
  const manifest = await (await page.request.get("/manifest.webmanifest")).json()
  expect(manifest.display).toBe("standalone")
  expect(manifest.icons.some((icon: { purpose: string }) => icon.purpose === "maskable")).toBe(true)
  const protocol = await context.newCDPSession(page)
  expect((await protocol.send("Page.getAppManifest")).errors).toEqual([])
  expect((await protocol.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([])
  await protocol.detach()
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys()
    return (await Promise.all(keys.map(async (key) => (await (await caches.open(key)).keys()).map((request) => request.url)))).flat()
  })
  expect(cached.some((url) => url.includes("/api/"))).toBe(false)
  expect(cached.some((url) => url.endsWith("/offline.html"))).toBe(true)
  await context.setOffline(true)
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled()
  await page.reload()
  await expect(page.getByRole("heading", { name: "You’re offline." })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Your next message" })).toHaveValue("A thought that survives offline")
  await page.getByRole("textbox", { name: "Your next message" }).fill("Edited while offline")
  await context.setOffline(false)
  await page.getByRole("link", { name: "Back to the room" }).click()
  await expect(page.getByRole("textbox", { name: "Message the room" })).toHaveValue("Edited while offline")
})
})

test("reduced motion and a compact viewport keep the composer accessible", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await mockRoom(page)
  await page.goto("/")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
  expect(await page.locator(".orb-cloud").first().evaluate((node) => getComputedStyle(node).animationName)).toBe("none")
  await page.setViewportSize({ width: 390, height: 420 })
  await expect(page.getByRole("textbox", { name: "Message the room" })).toBeInViewport()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)
})

test("the chat has no automated accessibility violations", async ({ page }) => {
  await mockRoom(page, [{ speaker: "Anna", text: "A clear thought, with room to breathe.", spoken: false }])
  await page.goto("/")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()
  expect(result.violations).toEqual([])
})
