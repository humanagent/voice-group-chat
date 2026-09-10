import { expect, said, test, type Page, AxeBuilder } from "../../../web/test-support/browser"
import type { ChallengeRun, Standing } from "../../../web/src/lib/challenge"

/**
 * A browser that has never named the room.
 *
 * The shared fixture arrives named, because the room asks for a name before it
 * will send anything and that is how anybody reaches a scored round in the
 * first place. Clearing it here is how the first visit is tested: the ask
 * itself, and what a saved result does in a browser that lost its name.
 */
const unnamed = (page: Page) => page.addInitScript(() => { try { localStorage.removeItem("room.player") } catch { /* private mode */ } })

const id = "88b4b3f3-7cbb-4870-afc6-0a11cd2b35e0"
const completed = (score: number): ChallengeRun => ({ id, score, target: 20, status: score === 20 ? "won" : "quiet", submitted: false })
const place: Standing = { rank: 4, total: 61 }
function stream(run: ChallengeRun) {
  return [
    { type: "challenge", run: { ...run, score: 0, status: "running" } },
    ...Array.from({ length: run.score }, (_, index) => [
      said(["Anna", "Jordan", "Pepe"][index % 3], `Reply ${index + 1}`),
      { type: "challenge", run: { ...run, score: index + 1, status: index + 1 === run.score ? run.status : "running" } },
    ]).flat(),
    { type: "challenge", run }, { type: "done" },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
}

/** Every route a scored round touches, and nothing that costs a provider call. */
async function mocks(page: Page, score = 20, restored: ChallengeRun | null = null) {
  let run = restored
  let standing: Standing | null = null
  let starts = 0
  let posts = 0
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "room" } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [{ speaker: "Anna", text: "Our existing conversation", spoken: false }] } }))
  await page.route("**/api/speak?*", (route) => route.fulfill({ status: 503, json: { error: "Speech mocked for browser tests" } }))
  await page.route("**/api/challenge", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { run, standing } })
    starts++
    // The scored round carries the player, exactly as the ordinary one does.
    expect(Object.keys(route.request().postDataJSON()).sort()).toEqual(["message", "speaker"])
    run = completed(score)
    standing = null
    await route.fulfill({ contentType: "text/event-stream", body: stream(run) })
  })
  await page.route("**/api/challenge/scoreboard", async (route) => {
    if (route.request().method() === "POST") {
      posts++
      // The name was given once, at the door. Publication repeats it; it never
      // asks for it again.
      expect(route.request().postDataJSON()).toEqual({ runId: id, name: "Tester" })
      run = { ...run!, submitted: true }
      standing = place
    }
    await route.fulfill({ json: { run, standing, entries: standing ? [{ id: "public-entry", rank: 1, name: "Tester", score, won: score === 20 }] : [] } })
  })
  return { starts: () => starts, posts: () => posts }
}

/** Land on the challenge page and take a round to the point of one prompt. */
async function setup(page: Page, score = 20, restored: ChallengeRun | null = null) {
  const round = await mocks(page, score, restored)
  await page.goto("/challenge")
  await expect(page.getByRole("region", { name: "The room", exact: true })).toHaveAttribute("aria-busy", "false")
  await expect(page.getByRole("heading", { name: "Global scoreboard" })).toBeVisible()
  await expect(page.getByRole("textbox", { name: "Message the room" })).toHaveCount(0)
  await page.getByRole("button", { name: restored && !restored.submitted ? "View result" : "Play", exact: true }).click()
  if (!restored || restored.submitted) {
    await page.getByRole("dialog", { name: "Keep them talking" }).getByRole("button", { name: "Play", exact: true }).click()
    await expect(page.getByRole("textbox", { name: "Message the room" })).toBeEditable()
  }
  return round
}

test("20 wins, publishes under the room's name and answers with a place", async ({ page }) => {
  const round = await setup(page)
  // The counter runs from Play, beside the cup, and not only inside a modal.
  await expect(page.getByLabel("Challenge: 0 of 20 replies")).toHaveText("0/20")
  await page.getByRole("textbox", { name: "Message the room" }).fill("Anna, ask everyone a question.")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.getByRole("heading", { name: "You won!" })).toBeVisible()
  await expect(page.getByLabel("20 of 20 replies")).toHaveText("20/20")
  // Named at the door, so the end of the round has nothing to ask and nothing
  // to press: the score is already on the board, with the place it took.
  await expect(page.getByRole("dialog")).toContainText("#4 of 61 on the board")
  await expect(page.getByLabel("Your name")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Publish score" })).toHaveCount(0)
  // The counter is finished, so it is gone from the header.
  await expect(page.getByLabel("Challenge: 20 of 20 replies")).toHaveCount(0)
  expect(round.starts()).toBe(1)
  await page.getByRole("dialog").getByRole("button", { name: "See the board" }).click()
  await expect(page.getByRole("list", { name: "Global rankings" })).toContainText("Tester")
  await expect(page.getByText("Winner", { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/challenge$/)
})

test("Play again starts the next round in one press, with the counter back at zero", async ({ page }) => {
  const round = await setup(page, 3)
  await page.getByRole("textbox", { name: "Message the room" }).fill("Ask everyone their age.")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.getByLabel("3 of 20 replies")).toHaveText("3/20")
  await expect(page.getByRole("heading", { name: "Round finished" })).toBeVisible()
  await expect(page.getByText("You won!")).toHaveCount(0)
  await expect(page.getByRole("dialog")).toContainText("#4 of 61 on the board")
  // No rules to read again, no second dialog: one press is back in the game.
  await page.getByRole("button", { name: "Play again" }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByLabel("Challenge: 0 of 20 replies")).toHaveText("0/20")
  await expect(page.getByRole("textbox", { name: "Message the room" })).toBeEditable()
  await expect(page.getByText("Next prompt counts", { exact: true })).toBeVisible()
  await expect(page.getByRole("progressbar")).toHaveCount(0)
  // The same room, with the same conversation still in it.
  await expect(page.getByText("Our existing conversation", { exact: true })).toBeAttached()
  await expect(page.getByText("Reply 3", { exact: true })).toBeVisible()
  expect(round.starts()).toBe(1)
})

test("a round with nothing said is not published, and says what to try instead", async ({ page }) => {
  const round = await setup(page, 0, completed(0))
  await expect(page.getByRole("heading", { name: "Round finished" })).toBeVisible()
  await expect(page.getByLabel("0 of 20 replies")).toHaveText("0/20")
  await expect(page.getByRole("dialog")).toContainText("No replies to count")
  await expect(page.getByRole("dialog")).not.toContainText("on the board")
  // Nobody wants their name on a board for a round where nothing was said.
  expect(round.posts()).toBe(0)
})

test("a reload neither repeats the prompt nor publishes the same score twice", async ({ page }) => {
  const round = await setup(page, 20, completed(20))
  await expect(page.getByRole("heading", { name: "You won!" })).toBeVisible()
  await expect(page.getByRole("dialog")).toContainText("#4 of 61 on the board")
  await page.reload()
  await expect(page.getByRole("heading", { name: "Global scoreboard" })).toBeVisible()
  // Already on the board: nothing is held back, and nothing is sent again.
  await expect(page.getByRole("button", { name: "View result", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled()
  expect(round.starts()).toBe(0)
  expect(round.posts()).toBe(1)
})

test("a score that cannot reach the board is kept, with a way back to it", async ({ page }) => {
  const round = await mocks(page, 6, completed(6))
  let broken = true
  // Registered last, so it answers first: the board is unreachable exactly once.
  await page.route("**/api/challenge/scoreboard", async (route) => {
    if (route.request().method() === "POST" && broken) {
      broken = false
      return route.fulfill({ status: 503, json: { error: "The challenge is unavailable. Please try again." } })
    }
    await route.fallback()
  })
  await page.goto("/challenge")
  await page.getByRole("button", { name: "View result", exact: true }).click()
  const result = page.getByRole("dialog", { name: "Round finished" })
  await expect(result).toContainText("The challenge is unavailable.")
  await expect(page.getByLabel("6 of 20 replies")).toHaveText("6/20")
  await result.getByRole("button", { name: "Try again" }).click()
  await expect(result).toContainText("#4 of 61 on the board")
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
  await page.getByRole("dialog", { name: "Keep them talking" }).getByRole("button", { name: "Play", exact: true }).click()
  await expect(input).toBeEditable()
  await expect(input).toHaveValue("Keep this draft")
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "room" } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [] } }))
  await page.getByRole("button", { name: "Room mode", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Tester’s room", exact: true })).toBeVisible()
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

test("Challenge always explains the game; dismissing the intro never records or clears the draft", async ({ page }) => {
  const round = await setup(page)
  const input = page.getByRole("textbox", { name: "Message the room" })
  await input.fill("Keep my room draft")
  await page.getByRole("button", { name: "Room mode", exact: true }).click()
  let tokens = 0
  await page.route("**/api/scribe", (route) => { tokens++; return route.fulfill({ status: 503, json: {} }) })
  for (let visit = 0; visit < 2; visit++) {
    await page.getByRole("button", { name: "Start challenge" }).click()
    const intro = page.getByRole("dialog", { name: "Keep them talking" })
    await expect(intro).toBeVisible()
    await expect(intro.getByLabel("0 of 20 replies")).toHaveText("0/20")
    // The two consequences of the button, said before it is pressed.
    await expect(intro).toContainText("published as Tester")
    await expect(intro.getByRole("button", { name: "Play", exact: true })).toBeFocused()
    expect(tokens).toBe(0)
    expect(round.starts()).toBe(0)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.keyboard.press("Escape")
    await expect(intro).toHaveCount(0)
    await expect(input).toHaveValue("Keep my room draft")
    await expect(input).toHaveAttribute("placeholder", "Type a message…")
  }
})

test("the first visit asks who is playing, and a saved result waits for the answer", async ({ page }) => {
  await unnamed(page)
  await mocks(page, 3, completed(3))
  await page.goto("/challenge")
  const gate = page.getByRole("dialog", { name: "Who’s playing?" })
  await expect(gate).toBeVisible()
  // The agents in this room, by name: the reason the question is being asked.
  await expect(gate).toContainText("Anna, Jordan and Pepe")
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled()
  // An agent's name would take that agent out of its own audience.
  await gate.getByLabel("Your name").fill("Anna")
  await gate.getByRole("button", { name: "Enter the room" }).click()
  await expect(gate.getByRole("alert")).toHaveText("Anna is already in the room.")
  await gate.getByLabel("Your name").fill("Tester")
  await gate.getByRole("button", { name: "Enter the room" }).click()
  await expect(gate).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled()
  // Named, the result it was holding publishes itself under that name.
  await page.getByRole("button", { name: "View result", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Round finished" })).toContainText("#4 of 61 on the board")
})

test("a late saved-result response cannot replace an input the player has tapped", async ({ page }) => {
  await unnamed(page)
  await page.route("**/api/room", (route) => route.fulfill({ json: { chat: "room" } }))
  await page.route("**/api/history?*", (route) => route.fulfill({ json: { lines: [] } }))
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  await page.route("**/api/challenge", async (route) => {
    await pending
    await route.fulfill({ json: { run: completed(3), standing: null } })
  })
  await page.route("**/api/challenge/scoreboard", (route) => route.fulfill({ json: { entries: [] } }))
  await page.goto("/challenge")
  const name = page.getByRole("dialog", { name: "Who’s playing?" }).getByLabel("Your name")
  await name.click()
  await name.fill("Fabri")
  release()
  await expect(name).toBeFocused()
  await expect(name).toHaveValue("Fabri")
})

test("the name and result dialogs fit a narrow keyboard-height viewport and are accessible", async ({ page }, info) => {
  await unnamed(page)
  await page.setViewportSize({ width: 320, height: 568 })
  await mocks(page, 20, completed(20))
  await page.goto("/challenge")
  const name = page.getByLabel("Your name")
  await name.fill("Tester")
  // A software keyboard leaves about this much of a small phone.
  await page.setViewportSize({ width: 320, height: 340 })
  await name.scrollIntoViewIfNeeded()
  await expect(name).toBeInViewport({ ratio: 1 })
  const enter = page.getByRole("button", { name: "Enter the room" })
  await enter.scrollIntoViewIfNeeded()
  await expect(enter).toBeInViewport({ ratio: 1 })
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.setViewportSize({ width: 320, height: 568 })
  await enter.click()
  await page.getByRole("button", { name: "View result", exact: true }).click()
  const stageBefore = await page.locator(".stage-wrap").boundingBox()
  await page.setViewportSize({ width: 320, height: 340 })
  await expect(page.locator(".stage-wrap")).toBeInViewport({ ratio: 1 })
  expect(await page.locator(".stage-wrap").boundingBox()).toEqual(stageBefore)
  const again = page.getByRole("button", { name: "Play again" })
  await again.scrollIntoViewIfNeeded()
  await expect(again).toBeInViewport({ ratio: 1 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.setViewportSize({ width: 320, height: 568 })
  await page.screenshot({ path: info.outputPath("challenge-won.png") })
})

test("a second prompt cannot be sent while an attempt is running", async ({ page }) => {
  await setup(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  let starts = 0
  // This round is served here rather than by the shared mock, so the board is
  // answered from here too, about this run.
  await page.route("**/api/challenge", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { run: completed(3), standing: null } })
    starts++
    await pending
    await route.fulfill({ contentType: "text/event-stream", body: stream(completed(3)) })
  })
  await page.route("**/api/challenge/scoreboard", (route) => route.request().method() === "POST"
    ? route.fulfill({ json: { run: { ...completed(3), submitted: true }, standing: place, entries: [] } })
    : route.fulfill({ json: { entries: [] } }))
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
  // Playing again spends a round; it never happens by pressing Enter on arrival.
  await expect(page.getByRole("button", { name: "Play again" })).not.toBeFocused()
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
    expect(route.request().postDataJSON()).toEqual({ chat: "room", message: "Keep chatting", speaker: "Tester" })
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
