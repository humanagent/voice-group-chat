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
  const box = page.getByRole("textbox", { name: "Message the room" })
  await box.fill("A long draft.\n".repeat(20))
  await box.focus()
  await page.setViewportSize({ width: 390, height: 340 })
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
