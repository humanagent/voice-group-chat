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
  await page.getByRole("button", { name: "Mute voice replies" }).click()
  return { starts: () => starts }
}

test("20 wins Hackapot, asks for a name, and publishes to the global scoreboard", async ({ page }) => {
  const round = await setup(page)
  await page.getByRole("textbox", { name: "Message the room" }).fill("Anna, ask everyone a question.")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.getByRole("heading", { name: "You won Hackapot!" })).toBeVisible()
  await expect(page.getByLabel("Challenge score")).toHaveText("20 / 20")
  await expect(page.getByLabel("Your name")).toBeVisible()
  await page.getByLabel("Your name").fill("Fabri")
  await page.getByRole("button", { name: "Publish score" }).click()
  await expect(page.getByText("Result published.")).toBeVisible()
  expect(round.starts()).toBe(1)
  await page.getByRole("link", { name: "View global scoreboard", exact: true }).click()
  await expect(page.getByRole("list", { name: "Global rankings" })).toContainText("Fabri")
  await expect(page.getByText("Hackapot winner")).toBeVisible()
})

test("three replies produce three points, not a win, and publication can be skipped", async ({ page }) => {
  await setup(page, 3)
  await page.getByRole("textbox", { name: "Message the room" }).fill("Ask everyone their age.")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.getByLabel("Challenge score")).toHaveText("3 / 20")
  await expect(page.getByRole("heading", { name: "The conversation ended." })).toBeVisible()
  await expect(page.getByText("You won Hackapot!")).toHaveCount(0)
  await page.getByRole("button", { name: "Skip & play again" }).click()
  await expect(page.getByLabel("Challenge score")).toHaveText("0 / 20")
  await expect(page.getByRole("textbox", { name: "Message the room" })).toBeVisible()
})

test("reload recovers an unpublished result without sending another prompt", async ({ page }) => {
  const round = await setup(page, 20, completed(20))
  await expect(page.getByRole("heading", { name: "You won Hackapot!" })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel("Your name")).toBeVisible()
  expect(round.starts()).toBe(0)
})

test("result form fits a narrow keyboard-height viewport and is accessible", async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 568 })
  await setup(page, 20, completed(20))
  const name = page.getByLabel("Your name")
  await name.fill("Fabri")
  await page.setViewportSize({ width: 320, height: 340 })
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
  await expect(page.getByRole("heading", { name: "The conversation ended." })).toBeVisible()
})
