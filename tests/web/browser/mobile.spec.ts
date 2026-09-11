import { expect, test, type Page } from "../../../web/test-support/browser"

async function openRoom(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "visual-room", complete: true } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [
    { speaker: "you", text: "Anna, ask everyone what they think.", spoken: false },
    { speaker: "Anna", text: "What would you change first?\n\nLet’s take it one step at a time.", spoken: false },
    { speaker: "Jordan", text: "Start with the small screen. Keep the conversation and controls within reach.", spoken: false },
  ] } }))
  await page.goto("/")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
}

async function showLatest(page: Page) {
  const scroller = page.locator(".room-conversation > div").first()
  // Draft/notice resizing changes the available scroll area. Establish one
  // explicit reading position instead of snapshotting a scheduler-dependent one.
  await scroller.evaluate(async (node) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    node.scrollTop = node.scrollHeight
  })
  await expect.poll(() => scroller.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThan(1)
  await expect(page.getByRole("button", { name: "Jump to latest messages" })).toHaveCount(0)
}

test("the composer field is never small enough for iOS to zoom the room", async ({ page }) => {
  // 16px is the threshold Safari zooms below, and the room does not zoom. It is
  // set in one media query with several other phone rules, which is exactly the
  // kind of rule that goes missing when that block is edited.
  for (const width of [320, 390, 430, 640]) {
    await page.setViewportSize({ width, height: 780 })
    await openRoom(page)
    await expect(page.getByRole("textbox", { name: "Message the room" })).toHaveCSS("font-size", "16px")
  }
})

for (const score of [1, 37]) {
  test(`centered trophy result of ${score}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const run = { id: "3f1a58e6-1c94-4f5e-9f0f-5a2d9d3b7c11", score, status: "quiet", submitted: false }
    await page.route("**/api/challenge", (route) => route.fulfill({ json: { run, standing: null } }))
    // The saved result publishes itself and settles on its place: that is the
    // dialog people actually see, so that is the one measured here.
    await page.route("**/api/challenge/scoreboard", (route) => route.request().method() === "POST"
      ? route.fulfill({ json: { run: { ...run, submitted: true }, standing: { rank: 3, total: 48 }, entries: [] } })
      : route.fulfill({ json: { entries: [] } }))
    await openRoom(page)
    const modal = page.getByRole("dialog")
    await expect(modal).toBeVisible()
    // A one-reply round says "1 reply", and a long one has no denominator to
    // measure itself against.
    await expect(page.getByLabel(`${score} ${score === 1 ? "reply" : "replies"}`)).toContainText(String(score))
    await expect(modal).toContainText("#3 of 48 on the board")
    const rect = (await modal.boundingBox())!
    expect(rect.x + rect.width / 2).toBeCloseTo(195, 0)
    expect(rect.y + rect.height / 2).toBeCloseTo(422, 0)
    await expect(page.getByRole("progressbar")).toHaveCount(0)
    if (info.project.name === "visual") await expect(page).toHaveScreenshot(`challenge-result-${score}.png`)
    else await page.screenshot({ path: info.outputPath(`challenge-result-${score}.png`) })
  })
}

for (const viewport of [{ width: 390, height: 844 }, { width: 440, height: 956 }]) {
test(`installed PWA consumes the safe area once at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
  await page.setViewportSize(viewport)
  const restingVisualHeight = viewport.height - 96
  await page.addInitScript((height) => {
    Object.defineProperty(navigator, "standalone", { get: () => true })
    // Reproduce Safari's short visual viewport even before focus.
    Object.defineProperty(visualViewport!, "height", { configurable: true, value: height })
  }, restingVisualHeight)
  await openRoom(page)
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--room-safe-top", "62px")
    document.documentElement.style.setProperty("--room-safe-bottom", "34px")
  })
  const geometry = () => page.evaluate(() => {
    const shell = document.querySelector(".room-shell")!.getBoundingClientRect()
    const footer = document.querySelector(".composer-wrap")!.getBoundingClientRect()
    const input = document.querySelector("form.composer")!.getBoundingClientRect()
    return { bottom: footer.bottom, gap: shell.bottom - footer.bottom, padding: footer.bottom - input.bottom }
  })
  await expect(page.locator("html")).toHaveAttribute("data-room-standalone", "true")
  await expect.poll(geometry).toEqual({ bottom: viewport.height, gap: 0, padding: 34 })
  if (info.project.name === "visual") await expect(page).toHaveScreenshot(`pwa-safe-area-${viewport.width}.png`)
  const input = page.getByRole("textbox", { name: "Message the room" })
  await input.focus()
  // Focus isn't a resize: no immediate 96px jump toward the top.
  await expect.poll(geometry).toEqual({ bottom: viewport.height, gap: 0, padding: 34 })
  await page.evaluate(() => {
    Object.defineProperty(visualViewport!, "height", { configurable: true, value: 360 })
    visualViewport!.dispatchEvent(new Event("resize"))
  })
  await expect.poll(geometry).toEqual({ bottom: 360, gap: 0, padding: 8 })
  // A mocked visual viewport does not render an OS keyboard: capture only
  // the app's visible area, not the empty space reserved for that keyboard.
  if (info.project.name === "visual") await expect(page).toHaveScreenshot(`pwa-keyboard-${viewport.width}.png`, { clip: { x: 0, y: 0, width: viewport.width, height: 360 } })
  await input.blur()
  await page.evaluate((height) => {
    Object.defineProperty(visualViewport!, "height", { configurable: true, value: height })
    visualViewport!.dispatchEvent(new Event("resize"))
  }, restingVisualHeight)
  await expect.poll(geometry).toEqual({ bottom: viewport.height, gap: 0, padding: 34 })
  await expect(page.getByRole("button", { name: "Install the room" })).toHaveCount(0)
})
}

for (const viewport of [
  { width: 320, height: 568 }, { width: 390, height: 844 },
  { width: 430, height: 932 }, { width: 844, height: 390 },
  { width: 1024, height: 500 },
]) {
  test(`mobile layout ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await openRoom(page)
    const box = page.getByRole("textbox", { name: "Message the room" })
    await box.fill("A draft with several lines.\nSecond line.\nThird line.")
    await expect(box).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeInViewport({ ratio: 1 })
    await expect.poll(() => page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth > innerWidth,
      vertical: document.documentElement.scrollHeight > innerHeight,
    }))).toEqual({ horizontal: false, vertical: false })
    const targets = await page.locator(".room-actions button, .composer button").evaluateAll((buttons) => buttons.map((button) => {
      const { width, height } = button.getBoundingClientRect()
      return { width, height }
    }))
    for (const target of targets) { expect(target.width).toBeGreaterThanOrEqual(44); expect(target.height).toBeGreaterThanOrEqual(44) }
    await showLatest(page)
    if (info.project.name === "visual") await expect(page).toHaveScreenshot(`conversation-${viewport.width}x${viewport.height}.png`)
    else await page.screenshot({ path: info.outputPath("conversation.png") })
  })
}

test("keyboard-sized viewport keeps notices and a long draft reachable", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openRoom(page)
  const stageBefore = await page.locator(".stage-wrap").boundingBox()
  const headerBefore = await page.locator(".room-header").boundingBox()
  const box = page.getByRole("textbox", { name: "Message the room" })
  await box.fill("A long draft.\n".repeat(20))
  await box.focus()
  await page.setViewportSize({ width: 390, height: 340 })
  await expect(page.locator(".stage-wrap")).toBeInViewport({ ratio: 1 })
  expect(await page.locator(".stage-wrap").boundingBox()).toEqual(stageBefore)
  expect(await page.locator(".room-header").boundingBox()).toEqual(headerBefore)
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
    dispatchEvent(new Event("offline"))
  })
  await expect(page.getByText("You’re offline. You can keep writing; send when you’re back.")).toBeVisible()
  await expect(box).toBeFocused()
  await expect(box).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeInViewport({ ratio: 1 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)
  await showLatest(page)
  if (info.project.name === "visual") await expect(page).toHaveScreenshot("keyboard-offline.png")
  else await page.screenshot({ path: info.outputPath("keyboard-offline.png") })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(box).toHaveValue("A long draft.\n".repeat(20))
  await expect(page.locator(".stage-wrap")).toBeVisible()
})

test("iOS installation instructions fit without shifting the composer offscreen", async ({ page, browserName }, info) => {
  test.skip(browserName === "firefox", "iOS install instructions use the mobile Safari user agent")
  await page.setViewportSize({ width: 320, height: 568 })
  await page.addInitScript(() => Object.defineProperty(navigator, "userAgent", { get: () => "iPhone" }))
  await openRoom(page)
  await page.getByRole("button", { name: "Install the room" }).click()
  await expect(page.getByText("In Safari, tap Share, then “Add to Home Screen”.")).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Message the room" })).toBeInViewport({ ratio: 1 })
  await showLatest(page)
  if (info.project.name === "visual") await expect(page).toHaveScreenshot("install-help.png")
  else await page.screenshot({ path: info.outputPath("install-help.png") })
  await page.getByRole("button", { name: "Dismiss install instructions" }).click()
})

test("challenge scoreboard and play share an edge-to-edge mobile shell", async ({ page }, info) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "room" } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [] } }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.route("**/api/challenge", (route) => route.fulfill({ json: { run: null } }))
  // Hold token acquisition to snapshot the existing composer recording without
  // opening a microphone or connecting to a paid provider.
  await page.route("**/api/scribe", () => {})
  await page.route("**/api/challenge/scoreboard", (route) => route.fulfill({ json: { entries: [
    { id: "first", rank: 1, name: "Alex", score: 31 },
    { id: "second", rank: 2, name: "Sam", score: 14 },
  ] } }))
  await page.goto("/challenge")
  const play = page.getByRole("button", { name: "Play", exact: true })
  await expect(play).toBeEnabled()
  await expect(page.getByRole("list", { name: "Global rankings" })).toContainText("Sam")
  await expect(play).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole("button", { name: "Back to the room" })).toBeInViewport({ ratio: 1 })
  if (info.project.name === "visual") await expect(page).toHaveScreenshot("challenge-scoreboard.png")
  else await page.screenshot({ path: info.outputPath("challenge-scoreboard.png") })
  await play.click()
  const intro = page.getByRole("dialog", { name: "Keep them talking" })
  await expect(intro).toBeVisible()
  await expect(intro.getByLabel("0 replies")).toContainText("0")
  if (info.project.name === "visual") await expect(page).toHaveScreenshot("challenge-intro.png")
  await intro.getByRole("button", { name: "Play", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Live transcription" })).toHaveText("Connecting microphone…")
  await expect(page.locator(".stage-wrap")).toBeInViewport({ ratio: 1 })
  if (info.project.name === "visual") await expect(page).toHaveScreenshot("challenge-play.png")
  else await page.screenshot({ path: info.outputPath("challenge-play.png") })
  await page.getByRole("button", { name: "Discard recording" }).click()
  await expect(page.getByRole("textbox", { name: "Message the room" })).toBeVisible()
  expect(errors).toEqual([])
})
