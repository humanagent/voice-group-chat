import { publicName } from "@/lib/challenge"
import { challengeBody, challengeFailure, owner, privateHeaders } from "@/lib/challenge-http"
import { ChallengeError, challengeStore } from "@/lib/challenge-store"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  try { return Response.json({ entries: challengeStore().scoreboard() }, { headers: privateHeaders }) }
  catch (error) { return challengeFailure(error) }
}

export async function POST(request: Request) {
  try {
    const body = await challengeBody(request)
    const name = publicName(body.name)
    if (!name || typeof body.runId !== "string" || !/^[\da-f-]{36}$/.test(body.runId) || Object.keys(body).some((key) => key !== "name" && key !== "runId")) {
      throw new ChallengeError(400, "Use a name of 1–24 letters, numbers, spaces or simple punctuation.")
    }
    const who = await owner()
    if (!who) throw new ChallengeError(401, "Open the challenge in the browser where you played.")
    const store = challengeStore()
    const run = store.publish(body.runId, who, name)
    console.info(JSON.stringify({ event: "challenge.published", version: 1, score: run.score }))
    return Response.json({ run, entries: store.scoreboard() }, { headers: privateHeaders })
  } catch (error) { return challengeFailure(error) }
}
