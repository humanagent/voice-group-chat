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
  // Zoom stays enabled here: disabling it in the meta is an accessibility
  // violation for the browser. The installed app locks it at runtime instead,
  // in use-room-viewport.ts, where it is a fixed surface by design.
  themeColor: "#17181f", colorScheme: "dark", interactiveWidget: "resizes-content",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">{children}<PerformanceMonitor /></body>
    </html>
  )
}
