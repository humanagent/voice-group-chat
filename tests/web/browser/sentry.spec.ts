import { expect, test } from "../../../web/test-support/browser"

test("Sentry receives sanitized errors and numeric failure logs, never chat content", async ({ page }) => {
  const envelopes: string[] = []
  await page.route("https://sentry.invalid/**", async (route) => {
    envelopes.push(route.request().postData() ?? "")
    await route.fulfill({ json: {} })
  })
  await page.route("**/api/room", (route) => route.fulfill({ status: 503, json: { error: "Unavailable" } }))
  await page.goto("/?text=PRIVATE_QUERY_SENTINEL")
  await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible()
  await page.getByRole("textbox", { name: "Message the room" }).fill("PRIVATE_DRAFT_SENTINEL")
  await page.evaluate(() => {
    console.warn("PRIVATE_CONSOLE_SENTINEL")
    setTimeout(() => { throw new TypeError("PRIVATE_ERROR_SENTINEL") }, 0)
  })
  // Run the production export path (also used when backgrounding the PWA).
  await page.evaluate(() => dispatchEvent(new Event("pagehide")))
  await expect.poll(() => envelopes.join("\n"), { timeout: 12_000 }).toContain("Application error (details removed for privacy)")
  await expect.poll(() => envelopes.join("\n"), { timeout: 12_000 }).toContain("room.room_error")
  await expect.poll(() => envelopes.join("\n"), { timeout: 12_000 }).toContain("room.performance")
  const payload = envelopes.join("\n")
  expect(payload).not.toMatch(/PRIVATE_|replay_event|replay_recording|"type":"transaction"/)
  expect(payload).toContain("room_error")
  expect(payload).not.toMatch(/"(request|breadcrumbs|user|extra)":/)
})
