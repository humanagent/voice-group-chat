"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { record } from "@/lib/telemetry"

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }

function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener)
  window.addEventListener("offline", listener)
  return () => { window.removeEventListener("online", listener); window.removeEventListener("offline", listener) }
}
const noSubscription = () => () => {}
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || !!(navigator as Navigator & { standalone?: boolean }).standalone

export function usePwa() {
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true)
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null)
  const ios = useSyncExternalStore(noSubscription, isIos, () => false)
  const standalone = useSyncExternalStore(noSubscription, isStandalone, () => false)
  const [installed, setInstalled] = useState(false)
  const [update, setUpdate] = useState<ServiceWorker | null>(null)

  useEffect(() => {
    const installation = () => { setInstalled(true); setInstallPrompt(null) }
    const prompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt) }
    window.addEventListener("beforeinstallprompt", prompt)
    window.addEventListener("appinstalled", installation)

    let disposed = false
    let registration: ServiceWorkerRegistration | undefined
    let installing: ServiceWorker | null = null
    const stateChange = () => {
      if (!disposed && installing?.state === "installed" && navigator.serviceWorker.controller) setUpdate(installing)
    }
    const updateFound = () => {
      installing?.removeEventListener("statechange", stateChange)
      installing = registration?.installing ?? null
      installing?.addEventListener("statechange", stateChange)
    }
    // Never cache development assets or hot-reload clients.
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).then((result) => {
        if (disposed) return
        registration = result
        setUpdate(result.waiting)
        result.addEventListener("updatefound", updateFound)
        updateFound()
      }).catch(() => record("pwa_error", 1))
    }
    return () => {
      disposed = true
      window.removeEventListener("beforeinstallprompt", prompt)
      window.removeEventListener("appinstalled", installation)
      registration?.removeEventListener("updatefound", updateFound)
      installing?.removeEventListener("statechange", stateChange)
    }
  }, [])

  async function install() {
    if (!installPrompt) return
    try {
      await installPrompt.prompt()
      await installPrompt.userChoice
      setInstallPrompt(null)
    } catch { record("pwa_error", 1) }
  }

  function applyUpdate() {
    if (!update) return
    navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true })
    update.postMessage({ type: "SKIP_WAITING" })
  }

  return { online, installed: installed || standalone, canInstall: !!installPrompt, ios, install, update: !!update, applyUpdate }
}
