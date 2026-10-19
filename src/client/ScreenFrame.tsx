import { createContext, memo, useContext, useEffect, useRef, useState } from "react"
import { SpinnerGap } from "@phosphor-icons/react/dist/csr/SpinnerGap"
import {
  acquirePreview,
  releasePreview,
  subscribePreviewBudget,
} from "./previewBudget"
import { previewPath, STATUS_ATTRIBUTE } from "../shared/preview"
import type { Scenario } from "../shared/types"
import { getState, useThumbnailUpdates } from "./data"
import { reportPreviewIssue } from "./previewIssues"
import { thumbnailFor } from "./thumbnailCache"
import type { ViewportSize } from "./viewports"

type Props = {
  scenario: Scenario
  compact?: boolean
  // Interactive previews are real CSS viewports, never transformed. Only non-interactive thumbnail
  // cards scale a fixed canvas. A missing size fills the available modal/full-page area.
  viewport?: ViewportSize
  revision?: number
}

// Native iframe navigations share the tab's history. Background recipes must not traverse the
// foreground app's history while someone inspects it. Cached images remain visible.
export const CompactPreviewActivity = createContext(true)

function LiveScreenFrame({
  scenario,
  compact = false,
  viewport,
  revision = 0,
}: Props) {
  const { id, title } = scenario
  const budgeted = compact
  const active = useContext(CompactPreviewActivity)
  const root = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [scale, setScale] = useState(0.25)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState("")
  const [visible, setVisible] = useState(!budgeted)
  const owner = useRef<object>({})
  const [slot, setSlot] = useState(!budgeted)
  useEffect(() => {
    if (!budgeted) return
    if (!visible || !active) {
      releasePreview(owner.current)
      setSlot(false)
      return
    }
    const request = () => setSlot(acquirePreview(owner.current))
    request()
    const unsubscribe = subscribePreviewBudget(request)
    return () => {
      unsubscribe()
      releasePreview(owner.current)
    }
  }, [budgeted, visible, active])
  const mounted = visible && slot && (!budgeted || active)
  const replayViewport = !scenario.url && !ready ? scenario.replayViewport : undefined
  // Failures are listed in the explorer's Issues panel with the screen they came from.
  useEffect(() => (error ? reportPreviewIssue(id, error) : undefined), [id, error])
  useEffect(() => {
    if (!budgeted || !root.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries[0].isIntersecting)
        if (!entries[0].isIntersecting) setReady(false)
      },
      { rootMargin: "0px" },
    )
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [budgeted])
  useEffect(() => {
    if (!compact || !root.current) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry.contentRect.width) return
      const nextScale = entry.contentRect.width / 1280
      setScale(nextScale)
    })
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [compact])
  useEffect(() => {
    setReady(false)
    setError("")
    let finished = false
    let timeout: number | undefined
    let observer: MutationObserver | undefined
    const settle = (status: string | null) => {
      if (!status || finished || (status !== "ready" && !status.startsWith("error:"))) return
      finished = true
      window.clearTimeout(timeout)
      observer?.disconnect()
      if (status === "ready") {
        setReady(true)
        setError("")
      } else setError(status.replace(/^error:\s*/, ""))
    }
    // Listen before inspecting the document: fast/cached hosts can report ready before this effect.
    // Some custom preview hosts only set the status attribute and do not send a message at all.
    const inspect = () => {
      observer?.disconnect()
      try {
        const html = frame.current?.contentDocument?.documentElement
        if (!html) return
        settle(html.getAttribute(STATUS_ATTRIBUTE))
        if (!finished) {
          observer = new MutationObserver(() => settle(html.getAttribute(STATUS_ATTRIBUTE)))
          observer.observe(html, { attributes: true, attributeFilter: [STATUS_ATTRIBUTE] })
        }
      } catch {
        // Cross-origin custom URLs can still report readiness through the existing message protocol.
      }
    }
    const message = (event: MessageEvent) => {
      if (
        event.origin === location.origin &&
        event.source === frame.current?.contentWindow &&
        event.data?.type === "uix:ready" &&
        event.data.id === id
      )
        settle("ready")
      if (
        event.origin === location.origin &&
        event.source === frame.current?.contentWindow &&
        event.data?.type === "uix:error" &&
        event.data.id === id
      )
        settle(`error: ${String(event.data.message)}`)
    }
    window.addEventListener("message", message)
    const iframe = frame.current
    iframe?.addEventListener("load", inspect)
    if (mounted) {
      inspect()
      if (!finished) timeout = window.setTimeout(() => {
        inspect()
        if (!finished)
          setError(
            "This preview is taking too long to load. Open the state and use Reset state to retry.",
          )
      }, 20000)
    }
    return () => {
      window.removeEventListener("message", message)
      iframe?.removeEventListener("load", inspect)
      observer?.disconnect()
      window.clearTimeout(timeout)
    }
  }, [id, revision, mounted])
  return (
    <div
      ref={root}
      className={compact ? "screen-thumbnail" : "screen-live-viewport"}
      style={!compact && viewport ? { width: viewport.width, height: viewport.height, flex: "none", marginInline: "auto" } : undefined}
    >
      {mounted && (
        <iframe
          key={`${id}-${revision}`}
          ref={frame}
          title={`${title} preview`}
          src={previewPath(scenario, getState()?.startPath ?? "/")}
          loading="eager"
          tabIndex={compact ? -1 : 0}
          aria-hidden={compact || undefined}
          className={compact ? "screen-thumbnail__frame" : "screen-live-frame"}
          style={{ ...(compact ? { transform: `scale(${scale})` } : {}), ...(replayViewport ? { width: replayViewport.width, height: replayViewport.height } : {}) }}
        />
      )}
      {!ready && visible && (
        <div className="screen-thumbnail__loading">
          {error ? (
            <span role="alert" className="p-4 text-red-600">
              {error}
            </span>
          ) : (
            <>
              <SpinnerGap
                size={20}
                className="animate-spin"
                aria-hidden="true"
              />
              <span className="sr-only">
                {slot ? "Loading preview" : "Preview queued"}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// Cards use a fresh cached capture when one exists, so they cost an image instead of an iframe and
// do not compete for the live-preview budget. Full-size previews are always live.
export default memo(function ScreenFrame(props: Props) {
  // Re-render when captures change, so a card swaps to its image as soon as it exists.
  useThumbnailUpdates()
  const cached =
    props.compact ? thumbnailFor(props.scenario.id) : undefined
  if (cached?.state === "fresh") {
    return (
      <div className="screen-thumbnail" data-thumbnail="cached">
        <img
          className="screen-thumbnail__image"
          src={cached.url}
          alt=""
          loading="lazy"
          decoding="async"
          title={`Captured ${new Date(cached.capturedAt).toLocaleString()}`}
        />
      </div>
    )
  }
  return <LiveScreenFrame {...props} />
})
