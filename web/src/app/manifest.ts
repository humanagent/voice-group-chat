import type { MetadataRoute } from "next"

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/", name: "The room", short_name: "The room",
    description: "Chat with agents using text or voice.",
    start_url: "/", scope: "/", display: "standalone", background_color: "#101116", theme_color: "#101116",
    categories: ["productivity", "social"], lang: "en",
    icons: [
      { src: "/icons/room-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/room-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/room-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }
}
