import { expect, test, type Page, AxeBuilder } from "../../../web/test-support/browser"
import type { ChallengeRun } from "../../../web/src/lib/challenge"

const id = "88b4b3f3-7cbb-4870-afc6-0a11cd2b35e0"
const completed = (score: number): ChallengeRun => ({ id, score, target: 20, status: score === 20 ? "won" : "quiet", submitted: false })
function stream(run: ChallengeRun) {
  return [
    { type: "challenge", run: { ...run, score: 0, status: "running" } },
    ...Array.from({ length: run.score }, (_, index) => [
      { type: "said", agent: ["Anna", "Jordan", "Pepe"][index % 3], text: `Reply ${index + 1}`, audio: null },
      { type: "challenge", run: { ...run, score: index + 1, status: index + 1 === run.score ? run.status : "running" } },
    ]).flat(),
    { type: "challenge", run }, { type: "done" },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
}
async function setup(page: Page, score = 20, restored: ChallengeRun | null = null) {
  let run = restored
  let published = false
  let starts = 0
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "room" } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [{ speaker: "Anna", text: "Our existing conversation", spoken: false }] } }))
  await page.route("**/api/speak?*", (route) => route.fulfill({ status: 503, json: { error: "Speech mocked for browser tests" } }))
  await page.route("**/api/challenge", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { run } })
    starts++
    expect(Object.keys(route.request().postDataJSON())).toEqual(["message"])
    run = completed(score)
    await route.fulfill({ contentType: "text/event-stream", body: stream(run) })
  })
  await page.route("**/api/challenge/scoreboard", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ runId: id, name: "Fabri" })
      published = true
      run = { ...run!, submitted: true }
    }
    await route.fulfill({ json: { run, entries: published ? [{ id: "public-entry", rank: 1, name: "Fabri", score, won: score === 20 }] : [] } })
  })
  await page.goto("/challenge")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
  await expect(page.getByRole("heading", { name: "Global scoreboard" })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Message the room" })).toHaveCount(0)
  await page.getByRole("button", { name: restored && !restored.submitted ? "View result" : "Play", exact: true }).click()
  if (!restored || restored.submitted) await expect(page.getByRole("textbox", { name: "Message the room" })).toBeEditable()
  return { starts: () => starts }
}

test("20 wins the challenge, asks for a name, and publishes to the global scoreboard", async ({ page }) => {
  const round = await setup(page)
  await page.getByRole("textbox", { name: "Message the room" }).fill("Anna, ask everyone a question.")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.getByRole("heading", { name: "You won!" })).toBeVisible()
  await expect(page.getByRole("dialog")).toBeVisible()
  await expect(page.getByLabel("20 of 20 replies")).toHaveText("20/20")
  await expect(page.getByLabel("Your name")).toBeVisible()
  await page.getByLabel("Your name").fill("Fabri")
  await page.getByRole("button", { name: "Publish score" }).click()
  await expect(page.getByText("Result published.")).toBeVisible()
  expect(round.starts()).toBe(1)
  await page.getByRole("dialog").getByRole("button", { name: "Back to the room" }).click()
  await page.getByRole("button", { name: "Global scoreboard", exact: true }).click()
  await expect(page.getByRole("list", { name: "Global rankings" })).toContainText("Fabri")
  await expect(page.getByText("Winner", { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/challenge$/)
  await page.getByRole("button", { name: "Play", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Message the room" })).toBeEditable()
  await expect(page.getByText("Next prompt counts", { exact: true })).toBeVisible()
  expect(round.starts()).toBe(1)
})

test("three replies produce three points, not a win, and publication can be skipped", async ({ page }) => {
  await setup(page, 3)
  await page.getByRole("textbox", { name: "Message the room" }).fill("Ask everyone their age.")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.getByLabel("3 of 20 replies")).toHaveText("3/20")
  await expect(page.getByRole("heading", { name: "Round finished" })).toBeVisible()
  await expect(page.getByText("You won!")).toHaveCount(0)
  await page.getByRole("button", { name: "Skip & play again" }).click()
  await expect(page.getByRole("textbox", { name: "Message the room" })).toBeEditable()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("progressbar")).toHaveCount(0)
  await expect(page.getByText("Our existing conversation", { exact: true })).toBeAttached()
  await expect(page.getByText("Reply 3", { exact: true })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Message the room" })).toBeVisible()
})

test("reload recovers an unpublished result without sending another prompt", async ({ page }) => {
  const round = await setup(page, 20, completed(20))
  await expect(page.getByRole("heading", { name: "You won!" })).toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: "View result", exact: true }).click()
  await expect(page.getByLabel("Your name")).toBeVisible()
  expect(round.starts()).toBe(0)
})

test("scoreboard and play share a URL, preserve drafts, and both can exit to the room", async ({ page }) => {
  const round = await setup(page)
  const input = page.getByRole("textbox", { name: "Message the room" })
  await input.fill("Keep this draft")
  await page.getByRole("button", { name: "Global scoreboard", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Global scoreboard" })).toBeVisible()
  await expect(page.locator(".stage-wrap")).toBeHidden()
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeInViewport({ ratio: 1 })
  await expect(page).toHaveURL(/\/challenge$/)
  expect(round.starts()).toBe(0)
  await page.getByRole("button", { name: "Play", exact: true }).click()
  await expect(input).toBeEditable()
  await expect(input).toHaveValue("Keep this draft")
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "room" } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [] } }))
  await page.getByRole("button", { name: "Room mode", exact: true }).click()
  await expect(page.getByRole("heading", { name: "The room", exact: true })).toBeVisible()
  await expect(input).toHaveValue("Keep this draft")
  await expect(page.getByText("Our existing conversation", { exact: true })).toBeAttached()
  await page.getByRole("button", { name: "Global scoreboard" }).click()
  await expect(page.getByRole("heading", { name: "Global scoreboard" })).toBeVisible()
  await page.getByRole("button", { name: "Back to the room", exact: true }).click()
  await expect(input).toHaveValue("Keep this draft")
})

test("challenge is the single leaderboard page", async ({ page }) => {
  await setup(page)
  await page.goto("/challenge")
  await expect(page).toHaveURL(/\/challenge$/)
  await expect(page.getByRole("heading", { name: "Global scoreboard" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
})

test("a late saved-result response cannot replace an input the player has tapped", async ({ page }) => {
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "room" } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [] } }))
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/challenge", async (route) => {
    await pending
    await route.fulfill({ json: { run: completed(3) } })
  })
  await page.route("**/api/challenge/scoreboard", (route) => route.fulfill({ json: { entries: [] } }))
  await page.goto("/challenge")
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled()
  await expect(page.getByRole("textbox", { name: "Message the room" })).toHaveCount(0)
  release()
  await page.getByRole("button", { name: "View result", exact: true }).click()
  await page.getByLabel("Your name").click()
  await expect(page.getByLabel("Your name")).toBeFocused()
})

test("result form fits a narrow keyboard-height viewport and is accessible", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await setup(page, 20, completed(20))
  const stageBefore = await page.locator(".stage-wrap").boundingBox()
  const name = page.getByLabel("Your name")
  await name.fill("Fabri")
  await page.setViewportSize({ width: 320, height: 340 })
  await expect(page.locator(".stage-wrap")).toBeInViewport({ ratio: 1 })
  expect(await page.locator(".stage-wrap").boundingBox()).toEqual(stageBefore)
  await name.scrollIntoViewIfNeeded()
  await expect(name).toBeInViewport({ ratio: 1 })
  await page.getByRole("button", { name: "Publish score" }).scrollIntoViewIfNeeded()
  await expect(page.getByRole("button", { name: "Publish score" })).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const a11y = await new AxeBuilder({ page }).analyze()
  expect(a11y.violations).toEqual([])
  await page.setViewportSize({ width: 320, height: 568 })
  await page.screenshot({ path: info.outputPath("challenge-won.png") })
})

test("a second prompt cannot be sent while an attempt is running", async ({ page }) => {
  await setup(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  let starts = 0
  await page.route("**/api/challenge", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { run: completed(3) } })
    starts++
    await pending
    await route.fulfill({ contentType: "text/event-stream", body: stream(completed(3)) })
  })
  await page.getByRole("textbox", { name: "Message the room" }).fill("One prompt")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await page.getByRole("textbox", { name: "Message the room" }).fill("No extra turn")
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled()
  await page.getByRole("textbox", { name: "Message the room" }).press("Enter")
  expect(starts).toBe(1)
  release()
  await expect(page.getByRole("heading", { name: "Round finished" })).toBeVisible()
})

test("result traps focus, Escape continues the same room, and only Play starts counting", async ({ page }) => {
  const round = await setup(page, 2)
  const input = page.getByRole("textbox", { name: "Message the room" })
  await input.fill("Anna, count to three, then ask Pepe to count to ten.")
  await input.press("Enter")
  const modal = page.getByRole("dialog")
  await expect(modal).toBeVisible()
  await expect(page.getByLabel("2 of 20 replies")).toHaveText("2/20")
  await expect(modal.getByRole("button", { name: "Back to the room" })).toBeFocused()
  await expect(page.getByLabel("Your name")).not.toBeFocused()
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press("Tab")
    expect(await modal.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press("Escape")
  await expect(modal).toHaveCount(0)
  await expect(page.getByText("Reply 2", { exact: true })).toBeVisible()
  let ordinary = 0
  await page.route("**/api/say", (route) => {
    ordinary++
    expect(route.request().postDataJSON()).toEqual({ chat: "room", message: "Keep chatting" })
    return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"done"}\n\n' })
  })
  await input.fill("Keep chatting")
  await input.press("Enter")
  await expect(page.getByText("Sent", { exact: true }).last()).toBeVisible()
  expect(ordinary).toBe(1)
  expect(round.starts()).toBe(1)
  await expect(page.getByRole("progressbar")).toHaveCount(0)
  await expect(page.getByText("Our existing conversation", { exact: true })).toBeAttached()
})
