import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

/**
 * The web tests live with the others, in `tests/` at the repo root, so the
 * three sides of this project — harness, runtime, web — are one tree and not
 * three conventions. Only the runner is different, because only the language
 * is.
 */
export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  test: {
    include: [resolve(__dirname, "../tests/web/**/*.test.ts")],
    environment: "node",
  },
})
