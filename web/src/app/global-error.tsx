"use client"

import { captureException } from "@sentry/nextjs"
import { useEffect } from "react"

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => { captureException(error) }, [error])
  // Independent of the failed root layout and its styles; never echo error text.
  return <html lang="en"><body style={{ margin: 0, background: "#17181f", color: "#eeedf3", fontFamily: "system-ui" }}>
    <main style={{ minHeight: "100dvh", boxSizing: "border-box", display: "grid", placeContent: "center", padding: "24px" }}>
      <h1 style={{ fontSize: "24px" }}>The room couldn’t load.</h1>
      <p>Your saved draft will be here when you return.</p>
      <button onClick={() => location.reload()} style={{ color: "#251e32", background: "#d8cafa", padding: "16px", border: 0, borderRadius: "12px", font: "inherit" }}>Reload the room</button>
    </main>
  </body></html>
}
