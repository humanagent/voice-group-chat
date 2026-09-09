import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
// No provider account or CI secret needed. Browser tests intercept this DSN.
const result = spawnSync(process.execPath, [require.resolve("next/dist/bin/next"), "build"], {
  stdio: "inherit",
  env: { ...process.env, NEXT_PUBLIC_SENTRY_DSN: "https://public@sentry.invalid/1", SENTRY_DSN: "", SENTRY_AUTH_TOKEN: "", SENTRY_ORG: "", SENTRY_PROJECT: "" },
})
process.exit(result.status ?? 1)
