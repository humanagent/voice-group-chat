/* Bump the version when changing offline assets. Only public assets are cached. */
const CACHE = "the-room-static-v3"
const SHELL = ["/offline.html", "/offline.css", "/offline.js", "/icons/room-192.png", "/icons/room-512.png", "/icons/room-maskable.png", "/icons/apple-touch-icon.png"]

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)))
})

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("the-room-static-") && name !== CACHE) await caches.delete(name)
    }
    await self.clients.claim()
  })())
})

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting()
})

self.addEventListener("fetch", (event) => {
  const { request } = event
  const url = new URL(request.url)
  // API traffic includes transcripts, speech and tokens. It must always use the network.
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")))
    return
  }
  if (!SHELL.includes(url.pathname)) return
  event.respondWith(caches.match(request, { ignoreSearch: true }).then((cached) => cached || fetch(request)))
})
