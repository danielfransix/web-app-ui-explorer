import { memo, useEffect, useRef, useState } from "react"
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

type Props = {
  scenario: Scenario
  compact?: boolean
  // A larger, interactive live view with a scaled 1280px canvas and a height fitted to the modal. It
  // always renders live, so it never uses a cached capture and never competes for the thumbnail budget.
  enlarged?: boolean
  revision?: number
}

function LiveScreenFrame({
  scenario,
  compact = false,
  enlarged = false,
  revision = 0,
}: Props) {
  const { id, title } = scenario
  const scaled = compact || enlarged
  const budgeted = compact && !enlarged
  const root = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [scale, setScale] = useState(0.25)
  const [frameHeight, setFrameHeight] = useState(900)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState("")
  const [visible, setVisible] = useState(!budgeted)
  const owner = useRef<object>({})
  const [slot, setSlot] = useState(!budgeted)
  useEffect(() => {
    if (!budgeted) return
    if (!visible) {
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
  }, [budgeted, visible])
  const mounted = visible && slot
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
    if (!scaled || !root.current) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry.contentRect.width) return
      const nextScale = entry.contentRect.width / 1280
      setScale(nextScale)
      if (enlarged) setFrameHeight(entry.contentRect.height / nextScale)
    })
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [scaled, enlarged])
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
      className={enlarged ? "screen-thumbnail screen-thumbnail--enlarged" : compact ? "screen-thumbnail" : "screen-live-viewport"}
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
          className={scaled ? `screen-thumbnail__frame${enlarged ? " screen-thumbnail__frame--interactive" : ""}` : "screen-live-frame"}
          style={scaled ? { transform: `scale(${scale})`, height: enlarged ? frameHeight : 900 } : undefined}
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
    props.compact && !props.enlarged ? thumbnailFor(props.scenario.id) : undefined
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
