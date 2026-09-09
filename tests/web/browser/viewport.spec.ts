import { expect, test } from "../../../web/test-support/browser"

test("iOS keyboard pan keeps the room above the keyboard and restores full height", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "room" } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [
    { speaker: "you", text: "A test message.", spoken: false },
    { speaker: "Anna", text: "A test reply.", spoken: false },
  ] } }))
  await page.goto("/")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
  const geometry = () => page.evaluate(() => {
    const rect = (selector: string) => {
      const bounds = document.querySelector(selector)!.getBoundingClientRect()
      return { top: bounds.top - visualViewport!.offsetTop, height: bounds.height }
    }
    return { header: rect(".room-header"), stage: rect(".stage-wrap"), messages: rect(".room-conversation") }
  })
  const before = await geometry()
  await page.getByRole("textbox", { name: "Message the room" }).focus()
  // Unlike setViewportSize, iOS keyboard focus leaves the layout viewport tall
  // and separately pans/shrinks the visual viewport. This reproduces that split.
  await page.evaluate(() => {
    Object.defineProperties(visualViewport!, {
      height: { configurable: true, value: 360 },
      offsetTop: { configurable: true, value: 190 },
    })
    visualViewport!.dispatchEvent(new Event("resize"))
    visualViewport!.dispatchEvent(new Event("scroll"))
  })
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true")
  await expect.poll(() => page.locator(".room-page").evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) }
  })).toEqual({ top: 190, bottom: 550, height: 360 })
  const focused = await geometry()
  expect(focused.header).toEqual(before.header)
  expect(focused.stage).toEqual(before.stage)
  expect(focused.messages.top).toBe(before.messages.top)
  expect(focused.messages.height).toBeLessThan(before.messages.height)
  expect(focused.messages.height).toBeGreaterThan(40)
  await expect(page.locator(".stage-wrap")).toBeVisible()
  await expect(page.locator(".agent-orbit")).toHaveCount(3)
  const composer = await page.locator(".composer-wrap").boundingBox()
  expect(composer!.y + composer!.height).toBeCloseTo(550, 0)
  await page.evaluate(() => {
    Object.defineProperty(visualViewport!, "offsetTop", { configurable: true, value: 240 })
    visualViewport!.dispatchEvent(new Event("scroll"))
  })
  await expect.poll(() => page.locator(".room-page").evaluate((node) => node.getBoundingClientRect().top)).toBe(240)
  expect((await geometry()).stage).toEqual(before.stage)
  // Dismissal may retain a stale, slightly-short visual viewport on iOS PWA.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement).blur()
    Object.defineProperties(visualViewport!, {
      height: { configurable: true, value: 790 }, offsetTop: { configurable: true, value: 0 },
    })
    visualViewport!.dispatchEvent(new Event("resize"))
  })
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "false")
  await expect.poll(() => page.locator(".room-page").evaluate((node) => Math.round(node.getBoundingClientRect().bottom))).toBe(844)
  await expect(page.locator(".stage-wrap")).toBeVisible()
  expect(await page.evaluate(() => scrollY)).toBe(0)
  // Leaving the room restores normal document scrolling for the ranking page.
  await page.route("**/api/challenge", (route) => route.fulfill({ json: { run: null } }))
  await page.route("**/api/challenge/scoreboard", (route) => route.fulfill({ json: { entries: [] } }))
  await page.getByRole("link", { name: "Play challenge" }).click()
  await page.getByRole("link", { name: "Global scoreboard", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Global scoreboard" })).toBeVisible()
  await expect(page.locator("html")).not.toHaveAttribute("data-room-viewport", "true")
  expect(await page.locator("body").evaluate((node) => getComputedStyle(node).position)).not.toBe("fixed")
})
