import { agents } from "@/lib/agents"
import { key, speechOff } from "@/lib/elevenlabs"
import { Room } from "@/components/room"

// Read at request time, not at build. The group is whatever `group.json` or
// `GROUP_AGENTS` says right now — baking the list into the bundle would ship a
// room full of agents that were running the day it was built.
export const dynamic = "force-dynamic"

export default function Page() {
  // Whether the room can speak is decided here rather than discovered by the
  // browser failing to fetch audio: a transcript line marked "spoken" beside
  // silence is a worse answer than one that never claimed it.
  return <Room names={agents().map((a) => a.name)} speech={!!key() && !speechOff()} />
}
