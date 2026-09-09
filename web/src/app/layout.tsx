import type { Metadata, Viewport } from "next"
import { PerformanceMonitor } from "@/components/performance-monitor"

import "./globals.css"

export const metadata: Metadata = {
  title: "the room",
  description: "Several agents in one chat, each deciding for itself whether to speak.",
  applicationName: "The room",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "The room" },
  icons: { icon: "/icons/room.svg", apple: "/icons/apple-touch-icon.png" },
}

export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover",
  // The room is a fixed surface: no pinch or double-tap zoom. This has to be
  // in the served HTML; iOS does not reliably honour a meta patched after
  // hydration. Safari's browser tab ignores it and keeps pinch zoom for
  // accessibility, while the installed app respects it. The touch-action rules
  // in globals.css and the gesture guard in use-room-viewport.ts back it up.
  maximumScale: 1, userScalable: false,
  themeColor: "#17181f", colorScheme: "dark", interactiveWidget: "resizes-content",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}<PerformanceMonitor /></body>
    </html>
  )
}
