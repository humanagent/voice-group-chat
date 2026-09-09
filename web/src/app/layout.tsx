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
  // The installed app is a fixed surface: no pinch or double-tap zoom. Safari
  // in the browser ignores this and keeps its own zoom, which is the right split.
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
