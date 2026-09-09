import { redirect } from "next/navigation"

// Keep existing shared links working; ranking and play now share one screen.
export default function Page() { redirect("/challenge") }
