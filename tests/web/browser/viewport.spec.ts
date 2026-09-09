import { expect, test } from "../../../web/test-support/browser"

test("first input tap requests focus without native centering; swipes and selection stay native", async ({ page }) => {
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "room" } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [] } }))
  await page.goto("/")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
  const results = await page.locator("textarea").evaluate((input) => {
    const options: (FocusOptions | undefined)[] = []
    const nativeFocus = input.focus.bind(input)
    input.focus = (option) => { options.push(option); nativeFocus(option) }
    const touch = (type: string, x = 20, count = 1) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      const touches = Array.from({ length: count }, (_, identifier) => ({ clientX: x, clientY: 20, identifier }))
      Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: touches } })
      input.dispatchEvent(event)
      return event.defaultPrevented
    }
    input.blur()
    touch("touchstart")
    const first = touch("touchend")
    const focused = document.activeElement === input
    touch("touchstart")
    const selection = touch("touchend")
    input.blur()
    touch("touchstart")
    touch("touchmove", 80)
    const swipe = touch("touchend", 80)
    touch("touchstart", 20, 2)
    const pinch = touch("touchend", 20, 2)
    return { first, focused, options, selection, swipe, pinch }
  })
  expect(results).toEqual({ first: true, focused: true, options: [{ preventScroll: true }], selection: false, swipe: false, pinch: false })
})

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
  // The scoreboard stays inside the same room shell; it no longer navigates
  // to a document-scrolling page or leaves the keyboard viewport lock behind.
  await page.route("**/api/challenge", (route) => route.fulfill({ json: { run: null } }))
  await page.route("**/api/challenge/scoreboard", (route) => route.fulfill({ json: { entries: [] } }))
  await page.getByRole("button", { name: "Global scoreboard" }).click()
  await expect(page.getByRole("heading", { name: "Global scoreboard" })).toBeVisible()
  await expect(page.locator("html")).toHaveAttribute("data-room-viewport", "true")
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeInViewport({ ratio: 1 })
})

test("tap focus survives keyboard frames and multiline sizing has no breakpoint jump", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "room" } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [] } }))
  await page.goto("/")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
  const input = page.getByRole("textbox", { name: "Message the room" })
  await input.fill("A multiline draft\n".repeat(20))
  await input.evaluate((node) => {
    node.dataset.blurCount = "0"
    node.addEventListener("blur", () => { node.dataset.blurCount = String(Number(node.dataset.blurCount) + 1) })
  })
  // Padding is part of the visible text field, not a keyboard-dismiss target.
  await page.locator("form.composer").click({ position: { x: 6, y: 6 } })
  await expect(input).toBeFocused()
  const frames = await page.evaluate(async () => {
    const input = document.querySelector("textarea")!
    const samples: { height: number; room: number; input: number; focused: boolean; stage: number }[] = []
    for (const height of [844, 820, 780, 724, 680, 621, 619, 574, 540, 500, 460, 400, 360]) {
      Object.defineProperties(visualViewport!, {
        height: { configurable: true, value: height },
        offsetTop: { configurable: true, value: (844 - height) / 3 },
      })
      visualViewport!.dispatchEvent(new Event("resize"))
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      samples.push({ height, room: document.querySelector(".room-page")!.getBoundingClientRect().height,
        input: input.getBoundingClientRect().height, focused: document.activeElement === input,
        stage: document.querySelector(".stage-wrap")!.getBoundingClientRect().top - visualViewport!.offsetTop })
    }
    return samples
  })
  for (const sample of frames) {
    expect(sample.room).toBeCloseTo(sample.height, 0)
    expect(sample.focused).toBe(true)
    expect(sample.stage).toBeCloseTo(frames[0].stage, 0)
  }
  for (let i = 1; i < frames.length; i++) {
    expect(frames[i - 1].input - frames[i].input).toBeLessThanOrEqual(frames[i - 1].height - frames[i].height + 1)
  }
  await expect(input).toHaveAttribute("data-blur-count", "0")
  const closing = await page.evaluate(async () => {
    document.querySelector("textarea")!.blur()
    const samples: { height: number; room: number }[] = []
    for (const height of [360, 400, 500, 620, 724, 790]) {
      Object.defineProperties(visualViewport!, {
        height: { configurable: true, value: height }, offsetTop: { configurable: true, value: 0 },
      })
      visualViewport!.dispatchEvent(new Event("resize"))
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      samples.push({ height, room: document.querySelector(".room-page")!.getBoundingClientRect().height })
    }
    return samples
  })
  for (const sample of closing) expect(sample.room).toBeCloseTo(sample.height, 0)
  await expect.poll(() => page.locator(".room-page").evaluate((node) => node.getBoundingClientRect().bottom)).toBe(844)
  const surfaces = await page.evaluate(() => [document.documentElement, document.body, document.querySelector(".room-shell")!, document.querySelector(".composer-wrap")!].map((node) => getComputedStyle(node).backgroundColor))
  expect(new Set(surfaces).size).toBe(1)
  const footer = await page.locator(".composer-wrap").boundingBox()
  expect(footer!.y + footer!.height).toBe(844)
  // The keyboard's dismissal control can leave the textarea focused on iOS.
  await input.focus()
  await page.evaluate(async () => {
    Object.defineProperty(visualViewport!, "height", { configurable: true, value: 360 })
    visualViewport!.dispatchEvent(new Event("resize"))
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    Object.defineProperty(visualViewport!, "height", { configurable: true, value: 790 })
    visualViewport!.dispatchEvent(new Event("resize"))
  })
  await expect.poll(() => page.locator(".room-page").evaluate((node) => node.getBoundingClientRect().bottom)).toBe(844)
  await expect(input).toBeFocused()
})
