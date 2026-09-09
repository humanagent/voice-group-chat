import { expect, test } from "../../../web/test-support/browser"

test("an update waits for a round, times out recoverably, and reloads with the saved draft", async ({ page }) => {
  await page.addInitScript(() => {
    // Explicitly simulate the worker lifecycle; real offline caching has its own test.
    const worker = Object.assign(new EventTarget(), { state: "installed", postMessage: () => {
      sessionStorage.setItem("update-posts", String(Number(sessionStorage.getItem("update-posts")) + 1))
    } })
    const registration = Object.assign(new EventTarget(), { waiting: worker, installing: null })
    const container = Object.assign(new EventTarget(), { controller: {}, register: async () => registration })
    Object.defineProperty(navigator, "serviceWorker", { value: container })
  })
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "pwa-test", complete: true } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [] } }))
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/say", async (route) => {
    await held
    await route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"done"}\n\n' })
  })
  await page.goto("/")
  const update = page.getByRole("button", { name: "Update", exact: true })
  await expect(update).toBeEnabled()
  const box = page.getByRole("textbox", { name: "Message the room" })
  await box.fill("Start a round")
  await box.press("Enter")
  await expect(update).toBeDisabled()
  release()
  await expect(update).toBeEnabled()
  await box.fill("Keep my draft through the update")
  await page.clock.install()
  await update.click()
  await expect(page.getByRole("button", { name: "Updating…", exact: true })).toBeDisabled()
  expect(await page.evaluate(() => sessionStorage.getItem("update-posts"))).toBe("1")
  await page.clock.fastForward(10_001)
  await expect(update).toBeEnabled()
  await update.click()
  await Promise.all([
    page.waitForEvent("load"),
    page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event("controllerchange"))),
  ])
  await expect(box).toHaveValue("Keep my draft through the update")
  expect(await page.evaluate(() => sessionStorage.getItem("update-posts"))).toBe("2")
})

test("an accepted install hides its action; an installed iOS app never offers installation", async ({ page }) => {
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "pwa-test", complete: true } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [] } }))
  await page.goto("/")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
  await page.evaluate(() => {
    const prompt = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: async () => { dispatchEvent(new Event("appinstalled")) },
      userChoice: Promise.resolve({ outcome: "accepted" }),
    })
    dispatchEvent(prompt)
  })
  await page.getByRole("button", { name: "Install the room" }).click()
  await expect(page.getByRole("button", { name: "Install the room" })).toHaveCount(0)
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { get: () => "iPhone" })
    Object.defineProperty(navigator, "standalone", { get: () => true })
  })
  await page.reload()
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
  await expect(page.getByRole("button", { name: "Install the room" })).toHaveCount(0)
})
