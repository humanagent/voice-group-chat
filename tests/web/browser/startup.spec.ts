import { expect, test } from "../../../web/test-support/browser"

test("slow startup protects the input, then allows drafts before the room connects", async ({ page }) => {
  let releaseScripts: () => void = () => {}
  let releaseRoom: () => void = () => {}
  const scripts = new Promise<void>((resolve) => { releaseScripts = resolve })
  const room = new Promise<void>((resolve) => { releaseRoom = resolve })
  let heldScripts = 0
  await page.addInitScript(() => localStorage.setItem("the-room-draft", "Saved before this visit"))
  await page.route(/\/_next\/static\/.*\.js(?:\?|$)/, async (route) => {
    heldScripts++
    await scripts
    await route.continue()
  })
  await page.route("**/api/room", async (route) => {
    await room
    await route.fulfill({ json: { chat: "room", agents: ["Steve", "Jordan", "Pepe"], complete: true } })
  })
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [] } }))
  await page.route("**/api/telemetry", (route) => route.fulfill({ status: 204 }))
  // Fail closed if the browser unexpectedly tries to send anything.
  const sent: string[] = []
  await page.route("**/api/say", (route) => { sent.push(route.request().postData() ?? ""); return route.abort() })
  await page.route("**/api/speak?*", (route) => route.abort())
  try {
    // DOMContentLoaded waits for scripts: commit lets us inspect actual SSR HTML.
    await page.goto("/", { waitUntil: "commit" })
    const input = page.getByRole("textbox", { name: "Message the room" })
    await expect(input).toBeVisible()
    await expect.poll(() => heldScripts).toBeGreaterThan(0)
    await expect(input).toBeDisabled()
    await expect(input).toHaveAttribute("placeholder", "Loading…")
    const bounds = await input.boundingBox()
    expect(bounds).not.toBeNull()
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
    await page.keyboard.type("Too early")
    await expect(input).toHaveValue("")
    await expect(input).not.toBeFocused()

    releaseScripts()
    await expect(input).toBeEditable()
    await expect(input).toHaveValue("Saved before this visit")
    await expect(input).toHaveAttribute("placeholder", "Type a message…")
    const hydratedBounds = await input.boundingBox()
    expect(hydratedBounds).not.toBeNull()
    expect(Math.abs(hydratedBounds!.height - bounds!.height)).toBeLessThan(1)
    expect(Math.abs(hydratedBounds!.y - bounds!.y)).toBeLessThan(1)
    const shell = page.getByRole("region", { name: "The room", exact: true })
    await expect(shell).toHaveAttribute("aria-busy", "true")
    await input.fill("A new thought while connecting")
    await expect.poll(() => page.evaluate(() => localStorage.getItem("the-room-draft"))).toBe("A new thought while connecting")
    const send = page.getByRole("button", { name: "Send message", exact: true })
    await expect(send).toBeDisabled()

    releaseRoom()
    await expect(shell).toHaveAttribute("aria-busy", "false")
    await expect(input).toHaveValue("A new thought while connecting")
    await expect(send).toBeEnabled()
    // The existing app remains useful without a gateway/network connection.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false })
      window.dispatchEvent(new Event("offline"))
    })
    await expect(send).toBeDisabled()
    await expect(input).toBeEditable()
    await input.fill("Still editable offline")
    await expect.poll(() => page.evaluate(() => localStorage.getItem("the-room-draft"))).toBe("Still editable offline")
    expect(sent).toEqual([])
  } finally {
    releaseScripts()
    releaseRoom()
  }
})

for (const storage of [true, false]) {
test(`offline startup protects the draft with storage ${storage ? "available" : "unavailable"}`, async ({ page }) => {
  let release: () => void = () => {}
  const script = new Promise<void>((resolve) => { release = resolve })
  await page.addInitScript((available) => {
    if (available) localStorage.setItem("the-room-draft", "Saved before going offline")
    else Object.defineProperty(window, "localStorage", { get: () => { throw new DOMException("Storage unavailable", "SecurityError") } })
  }, storage)
  await page.route("**/offline.js", async (route) => { await script; await route.continue() })
  try {
    await page.goto("/offline.html", { waitUntil: "commit" })
    const input = page.getByRole("textbox", { name: "Your next message" })
    await expect(input).toBeVisible()
    await expect(input).toBeDisabled()
    const before = await input.boundingBox()
    release()
    await expect(input).toBeEditable()
    await expect(input).toHaveValue(storage ? "Saved before going offline" : "")
    await expect(input).toHaveAttribute("placeholder", "Type a message…")
    expect(await input.boundingBox()).toEqual(before)
    await input.fill("A thought to keep offline")
    if (storage) {
      await expect.poll(() => page.evaluate(() => localStorage.getItem("the-room-draft"))).toBe("A thought to keep offline")
      await expect(page.getByRole("status")).toHaveText("Draft saved on this device.")
    } else {
      await expect(page.getByRole("status")).toContainText("Storage is unavailable")
      await expect(input).toHaveValue("A thought to keep offline")
    }
  } finally { release() }
})
}
