import { agents } from "@/lib/agents"
import { history, ROOM } from "@/lib/group"

export const dynamic = "force-dynamic"

/** What was already said in a room, so entering one is not entering a blank. */
export async function GET(request: Request) {
  const chat = new URL(request.url).searchParams.get("chat")
  if (chat !== ROOM) return Response.json({ lines: [] }, { status: 404 })
  const group = agents()
  if (!chat || !group.length) return Response.json({ lines: [] })
  try {
    return Response.json({ lines: await history(group[0], chat) })
  } catch {
    return Response.json({ lines: [] })
  }
}
