import { readFileSync } from "node:fs"
import { join } from "node:path"

import { stateRoot } from "@/lib/state"

/**
 * One agent of the group: a name and the gateway that answers for it.
 *
 * Every agent is its own Hermes process with its own port and its own key —
 * that is what makes them separate agents rather than one wearing three names.
 */
export type Agent = {
  name: string
  url: string
  key: string
}

/**
 * The group, from the environment or from the file the Python already writes.
 *
 * `scripts/group_up.py` writes `group.json` at the repo root every time it
 * starts the group, so locally there is nothing to configure: the same file
 * that tells the terminal client where the agents are tells this one.
 *
 * Deployed there is no such file and no localhost either, so `GROUP_AGENTS`
 * carries the same shape as JSON. Same fields, so a deploy is a copy of the
 * file into an environment variable.
 */
export function agents(): Agent[] {
  const fromEnv = process.env.GROUP_AGENTS?.trim()
  if (fromEnv) return normalise(JSON.parse(fromEnv))

  try {
    const local = readFileSync(join(stateRoot(), "group.json"), "utf8")
    return normalise(JSON.parse(local))
  } catch {
    return []
  }
}

type Loose = { name?: string; url?: string; host?: string; port?: number; key?: string }

/**
 * `group.json` records a port; a deployment records a URL. Both arrive here.
 */
function normalise(raw: Loose[] | { agents?: Loose[] }): Agent[] {
  const list = Array.isArray(raw) ? raw : (raw.agents ?? [])
  return list
    .filter((a): a is Loose & { name: string; key: string } => !!a.name && !!a.key)
    .map((a) => ({
      name: a.name,
      key: a.key,
      url: a.url ?? `http://${a.host ?? "127.0.0.1"}:${a.port ?? 8700}`,
    }))
}
