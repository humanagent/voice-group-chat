import type { KeyboardEvent } from "react"

/** Safari may skip buttons in its native Tab order; keep all modal actions reachable. */
export function cycleDialogFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return
  const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex='0']"))
  const index = controls.indexOf(document.activeElement as HTMLElement)
  const next = (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
  event.preventDefault()
  controls[next]?.focus({ preventScroll: true })
}
