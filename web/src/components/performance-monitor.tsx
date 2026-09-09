"use client"

import { useState, useSyncExternalStore } from "react"
import { useReportWebVitals } from "next/web-vitals"
import { ActivityIcon, DownloadIcon, XIcon } from "lucide-react"
import { getSamples, record, subscribe } from "@/lib/telemetry"
import { metricNames, type MetricName, type Sample } from "@/lib/telemetry-schema"

const empty: Sample[] = []
const noSubscription = () => () => {}
const isEnabled = () => new URLSearchParams(location.search).get("perf") === "1"
const limits: Partial<Record<MetricName, number>> = { LCP: 2500, INP: 200, CLS: 0.1, FCP: 1800, TTFB: 800 }
const shown: MetricName[] = ["LCP", "INP", "CLS", "frame_p95", "frame_stalls", "long_task", "first_reply", "round_duration"]
const labels: Partial<Record<MetricName, string>> = { frame_p95: "Frame interval · p95", frame_stalls: "Frames over 50ms", long_task: "Last long task", first_reply: "First reply", round_duration: "Full round" }

function report(metric: { name: string; value: number; id: string }) {
  if (metricNames.includes(metric.name as MetricName)) record(metric.name as MetricName, metric.value, metric.id)
}

function Diagnostics() {
  const samples = useSyncExternalStore(subscribe, getSamples, () => empty)
  const [open, setOpen] = useState(true)
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(samples, null, 2)], { type: "application/json" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "room-performance.json"
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  if (!open) return <button className="perf-toggle" onClick={() => setOpen(true)} aria-label="Open performance diagnostics"><ActivityIcon size={18} /></button>
  return (
    <aside className="perf-panel" aria-label="Performance diagnostics">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium"><ActivityIcon size={15} /> Room vitals</span>
        <div className="flex gap-2">
          <button onClick={download} aria-label="Download performance report"><DownloadIcon size={16} /></button>
          <button onClick={() => setOpen(false)} aria-label="Close performance diagnostics"><XIcon size={16} /></button>
        </div>
      </div>
      <dl className="mt-4 space-y-2 text-xs">
        {shown.map((name) => {
          const sample = samples.findLast((item) => item.name === name)
          const threshold = limits[name]
          return <div key={name} className="flex justify-between gap-5"><dt className="text-muted-foreground">{labels[name] ?? name}</dt><dd className={sample && threshold !== undefined ? sample.value <= threshold ? "text-emerald-300" : "text-amber-300" : ""}>{sample ? `${name === "CLS" ? sample.value.toFixed(3) : Math.round(sample.value)}${name === "CLS" || name === "frame_stalls" ? "" : " ms"}` : "Awaiting sample"}</dd></div>
        })}
      </dl>
      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">Frame samples cover 2.5s after interaction. Vitals appear when the browser reports them. This visit only; no message content is collected.</p>
    </aside>
  )
}

export function PerformanceMonitor() {
  useReportWebVitals(report)
  const enabled = useSyncExternalStore(noSubscription, isEnabled, () => false)
  return enabled ? <Diagnostics /> : null
}
