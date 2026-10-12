import { useEffect, useRef, useState } from "react"
import { SpinnerGap } from "@phosphor-icons/react/dist/csr/SpinnerGap"
import {
  acquirePreview,
  releasePreview,
  subscribePreviewBudget,
} from "./previewBudget"
import { previewPath, STATUS_ATTRIBUTE } from "../shared/preview"
import type { Scenario } from "../shared/types"
import { getState, useExplorerState } from "./data"
import { reportPreviewIssue } from "./previewIssues"
import { thumbnailFor } from "./thumbnailCache"

type Props = {
  scenario: Scenario
  compact?: boolean
  // A larger, non-interactive live view of the same scaled 1280x900 canvas used by thumbnails. It
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
    const observer = new ResizeObserver((entries) =>
      setScale(entries[0].contentRect.width / 1280),
    )
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [scaled])
  useEffect(() => {
    setReady(false)
    setError("")
    const message = (event: MessageEvent) => {
      if (
        event.origin === location.origin &&
        event.source === frame.current?.contentWindow &&
        event.data?.type === "uix:ready" &&
        event.data.id === id
      )
        setReady(true)
      if (
        event.origin === location.origin &&
        event.source === frame.current?.contentWindow &&
        event.data?.type === "uix:error" &&
        event.data.id === id
      )
        setError(String(event.data.message))
    }
    window.addEventListener("message", message)
    if (mounted) {
      const timeout = window.setTimeout(() => {
        const state = frame.current?.contentDocument?.documentElement.getAttribute(STATUS_ATTRIBUTE)
        if (state === "ready") setReady(true)
        else if (state) setError(state.replace(/^error:\s*/, ""))
        else
          setError(
            "This preview is taking too long to load. Open the state and use Reset state to retry.",
          )
      }, 20000)
      return () => {
        window.removeEventListener("message", message)
        window.clearTimeout(timeout)
      }
    }
    return () => window.removeEventListener("message", message)
  }, [id, revision, mounted])
  return (
    <div
      ref={root}
      className={scaled ? "screen-thumbnail" : "screen-live-viewport"}
    >
      {mounted && (
        <iframe
          key={`${id}-${revision}`}
          ref={frame}
          title={`${title} preview`}
          src={previewPath(scenario, getState()?.startPath ?? "/")}
          loading={budgeted ? "lazy" : "eager"}
          tabIndex={scaled ? -1 : 0}
          aria-hidden={compact || undefined}
          className={scaled ? "screen-thumbnail__frame" : "screen-live-frame"}
          style={scaled ? { transform: `scale(${scale})` } : undefined}
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
export default function ScreenFrame(props: Props) {
  // Re-render when captures change, so a card swaps to its image as soon as it exists.
  useExplorerState()
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
}
