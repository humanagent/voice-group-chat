import { resolve } from "node:path"

/**
 * Where the agents keep what they are, as opposed to where the code lives.
 *
 * Locally the two are the same directory: this app runs out of `web/`, the
 * homes and `group.json` sit one level up beside it, and `..` is the whole
 * answer. In a container they are not the same at all. The code is baked into
 * an image and replaced on every deploy; the homes, the drawn cast and the
 * session databases live on a mounted volume and have to survive one.
 *
 * `HERMES_GROUP_STATE` is the same variable the Python reads, deliberately, so
 * there is one answer to "where is the state" rather than two that can disagree
 * about it. Unset, this is exactly what every one of these call sites used to
 * compute inline.
 */
export function stateRoot(): string {
  return process.env.HERMES_GROUP_STATE?.trim() || resolve(process.cwd(), "..")
}
