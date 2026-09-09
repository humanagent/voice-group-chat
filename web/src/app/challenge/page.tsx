import { agents } from "@/lib/agents"
import { key } from "@/lib/elevenlabs"
import { Room } from "@/components/room"

export const dynamic = "force-dynamic"
export const metadata = { title: "Hackapot challenge · The room" }

export default function Page() {
  return <Room names={agents().map((agent) => agent.name)} speech={!!key()} challenge />
}
