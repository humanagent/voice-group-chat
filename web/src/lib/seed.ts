/**
 * A stable pattern per agent.
 *
 * The orb's swirl comes from a seed, and the colours are the component's own —
 * nothing here recolours them. So this is the whole of what makes one agent's
 * orb its own: a name that always hashes to the same number gives each a face
 * that survives a reload.
 */
export function seedFor(name: string): number {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 100000
  return hash
}
