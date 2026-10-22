import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft } from "@phosphor-icons/react/dist/csr/ArrowLeft"
import { ArrowCounterClockwise } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise"
import { ArrowRight } from "@phosphor-icons/react/dist/csr/ArrowRight"
import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise"
import { SquaresFour } from "@phosphor-icons/react/dist/csr/SquaresFour"
import { Graph } from "@phosphor-icons/react/dist/csr/Graph"
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass"
import { ArrowSquareOut } from "@phosphor-icons/react/dist/csr/ArrowSquareOut"
import { Command } from "@phosphor-icons/react/dist/csr/Command"
import { Compass } from "@phosphor-icons/react/dist/csr/Compass"
import { DotsThree } from "@phosphor-icons/react/dist/csr/DotsThree"
import { FolderSimple } from "@phosphor-icons/react/dist/csr/FolderSimple"
import { LockSimple } from "@phosphor-icons/react/dist/csr/LockSimple"
import { SpinnerGap } from "@phosphor-icons/react/dist/csr/SpinnerGap"
import { TerminalWindow } from "@phosphor-icons/react/dist/csr/TerminalWindow"
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle"
import { X } from "@phosphor-icons/react/dist/csr/X"
import type { Scenario } from "../shared/types"
import { Button, ContextPanel, CopyField, Heading, Input, RadioGroup, RadioOption, Tooltip } from "./ui"
import {
  cancelCapture,
  cancelCrawl,
  connections as buildConnections,
  isState,
  startCrawl,
  startCapture,
  isStatic,
  useExplorerFailure,
  useExplorerState,
  type ExplorerState,
} from "./data"
import ScreenFrame, { CompactPreviewActivity } from "./ScreenFrame"
import FolderNavigator from "./FolderNavigator"
import LoginPickerBanner, { type LoginMethod } from "./LoginPickerBanner"
import LogsPanel from "./LogsPanel"
import ScreenPicker from "./ScreenPicker"
import ScreenLightbox from "./ScreenLightbox"
import FigmaExport from "./FigmaExport"
import FigmaConnection from "./FigmaConnection"
import ScreenSelect, { ScreenSelectRadio } from "./ScreenSelect"
import useArrowKeys from "./useArrowKeys"
import { useLoginCapture } from "./useLoginCapture"
import { useAutoLogin } from "./useAutoLogin"
import IssuesPanel, { type Issue } from "./IssuesPanel"
import { usePreviewIssues } from "./previewIssues"
import { readSession, writeSession } from "./sessionState"
import { thumbnailFor } from "./thumbnailCache"
import { DEFAULT_CUSTOM_WIDTH, isCustomWidth, isViewportPreset, type ViewportPreset } from "./viewports"
import {
  buildFolderTree,
  decodeFolderRules,
  encodeFolderRules,
  folderCounts,
  folderCrumb,
  pathSelected,
  scenarioFolder,
  scenarioSource,
  toggleFolder,
  type FolderRule,
} from "./folderModel"

const FlowCanvas = lazy(() => import("./FlowCanvas"))

type View = "gallery" | "canvas" | "screen"
const readView = (query: URLSearchParams): View => {
  const view = query.get("view")
  return view === "canvas" || view === "screen" ? view : "gallery"
}

// The Navigation API traverses the explorer's entries, skipping history created inside its iframe.
// Older browsers return locally without depending on the iframe's joint session history.
function backLayer(fallback: () => void) {
  const navigation = (window as Window & {
    navigation?: { back(): { finished: Promise<unknown> } }
  }).navigation
  if (navigation) void navigation.back().finished.catch(fallback)
  else fallback()
}

function JobStatus({ state }: { state: ExplorerState }) {
  const { crawl, capture } = state.jobs
  if (crawl.status === "running")
    return (
      <div className="design-job" role="status" aria-label="Exploring">
        <SpinnerGap size={16} className="animate-spin" aria-hidden="true" />
        <span>{Number(crawl.progress?.states ?? 0)} found</span>
        <Tooltip label="Stop exploring" side="bottom">
          <Button variant="ghost" size="icon" aria-label="Stop exploring" onClick={() => void cancelCrawl()}>
            <X size={16} />
          </Button>
        </Tooltip>
      </div>
    )
  if (capture.status === "running")
    return (
      <div className="design-job" role="status" aria-label="Capturing thumbnails">
        <SpinnerGap size={16} className="animate-spin" aria-hidden="true" />
        <span>
          {Number(capture.progress?.done ?? 0)}/{Number(capture.progress?.total ?? 0)}
        </span>
        <Tooltip label="Stop capturing" side="bottom">
          <Button variant="ghost" size="icon" aria-label="Stop capturing" onClick={() => void cancelCapture()}>
            <X size={16} />
          </Button>
        </Tooltip>
      </div>
    )
  if (crawl.status === "done" && crawl.needsLogin)
    return (
      <div className="design-job design-job--error" role="status" aria-label="Login needed" title="Explorer only reached a login screen. Log in once to let it see the rest of the app.">
        <LockSimple size={16} aria-hidden="true" />
        <span>Only a login screen was found</span>
      </div>
    )
  const failed = crawl.status === "error" ? crawl : capture.status === "error" ? capture : undefined
  if (failed)
    return (
      <div className="design-job design-job--error" role="alert" title={failed.message}>
        <WarningCircle size={16} aria-hidden="true" />
        <span>{crawl.status === "error" ? "Exploring failed" : "Capture failed"}</span>
      </div>
    )
  const replayFailures = Number(crawl.progress?.failedReplays ?? (crawl.status === "idle" ? state.crawlStats?.failedReplays : 0) ?? 0)
  const stoppedBy = crawl.progress?.stoppedBy ?? (crawl.status === "idle" ? state.crawlStats?.stoppedBy : undefined)
  const limited = stoppedBy === "time-budget" || stoppedBy === "max-states"
  if (replayFailures > 0 || limited)
    return (
      <div className="design-job design-job--error" role="status" aria-label="Exploration incomplete" title="The catalog may be missing screens. Inspect failed replays or increase the crawl limits and explore again.">
        <WarningCircle size={16} aria-hidden="true" />
        <span>{replayFailures > 0 ? `${replayFailures} replay ${replayFailures === 1 ? "failure" : "failures"}` : stoppedBy === "time-budget" ? "Time limit reached" : "State limit reached"}</span>
      </div>
    )
  return null
}

type Origin = "manual" | "crawled" | "both"

function CatalogTotals({ label, screens, sections, connections }: { label: string; screens: number; sections: number; connections: number }) {
  return (
    <div className="design-workbench-metrics design-origin-metrics" role="group" aria-label={`${label} catalog totals`}>
      <div><strong>{screens}</strong><span>Screens</span></div>
      <div><strong>{sections}</strong><span>Sections</span></div>
      <div><strong>{connections}</strong><span>Connections</span></div>
    </div>
  )
}

function Loaded({ data }: { data: ExplorerState }) {
  // Hand-written and explored scenarios can both exist; show the curated set unless there is none.
  const hasManual = data.scenarios.some((s) => s.origin === "manual")
  const hasCrawled = data.scenarios.some((s) => s.origin !== "manual")
  const [picking, setPicking] = useState(false)
  const [loginPick, setLoginPick] = useState<string | undefined>(undefined)
  const [loginMethod, setLoginMethod] = useState<LoginMethod | undefined>(undefined)
  const loginCapture = useLoginCapture()
  const autoLogin = useAutoLogin()
  const [logsOpen, setLogsOpen] = useState(false)
  const [chosenOrigin, setChosenOrigin] = useState<Origin | undefined>(() => {
    const saved = readSession("origin")
    return saved === "manual" || saved === "crawled" || saved === "both" ? saved : undefined
  })
  useEffect(() => {
    if (chosenOrigin) writeSession("origin", chosenOrigin)
  }, [chosenOrigin])
  const origin: Origin = !hasManual ? "crawled" : !hasCrawled ? "manual" : (chosenOrigin ?? "manual")
  const scenarios = useMemo(
    () =>
      origin === "both"
        ? data.scenarios
        : data.scenarios.filter((s) => (s.origin === "manual") === (origin === "manual")),
    [data.scenarios, origin],
  )
  const [query, setQuery] = useState(() => new URLSearchParams(location.search))
  const [search, setSearch] = useState("")
  const [screenSelection, setScreenSelection] = useState<Set<string>>(() => {
    const saved = readSession("figma-screen-selection")
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [])
  })
  useEffect(() => { writeSession("figma-screen-selection", [...screenSelection]) }, [screenSelection])
  const setScreenSelected = useCallback((id: string, checked: boolean) => {
    setScreenSelection(previous => {
      const next = new Set(previous)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  // An explicit batch survives browsing filters; removed catalog entries are never exported.
  const exportScreens = useMemo(() => data.scenarios.filter(s => screenSelection.has(s.id)), [data.scenarios, screenSelection])
  const [revision, setRevision] = useState(0)
  const [viewport, setViewport] = useState<ViewportPreset>(() => {
    const saved = readSession("preview-viewport")
    return isViewportPreset(saved) ? saved : "fit"
  })
  useEffect(() => {
    writeSession("preview-viewport", viewport)
  }, [viewport])
  const [customWidth, setCustomWidth] = useState(() => {
    const saved = readSession("preview-custom-width")
    return isCustomWidth(saved) ? saved : DEFAULT_CUSTOM_WIDTH
  })
  useEffect(() => {
    writeSession("preview-custom-width", customWidth)
  }, [customWidth])
  const [infoOpen, setInfoOpen] = useState(false)
  const [issuesOpen, setIssuesOpen] = useState(false)
  const liveIssues = usePreviewIssues()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSession("sidebar-collapsed") === true)
  useEffect(() => {
    writeSession("sidebar-collapsed", sidebarCollapsed)
  }, [sidebarCollapsed])
  const [folders, setFolders] = useState<FolderRule[]>(() => {
    // A `folders` link param (shared by someone else, or from an earlier visit) wins over this
    // browser's own session, since picking a link is a more specific intent than picking up where
    // this tab left off.
    const fromLink = decodeFolderRules(new URLSearchParams(location.search).get("folders"))
    if (fromLink.length) return fromLink
    const saved = readSession("folders")
    return Array.isArray(saved)
      ? saved
          .filter((rule) => typeof rule?.path === "string" && typeof rule.selected === "boolean")
          .map(({ path, selected }) => ({ path, selected }))
      : []
  })
  const folderTree = useMemo(() => buildFolderTree(data.sources, scenarios), [data.sources, scenarios])
  const counts = useMemo(() => folderCounts(scenarios), [scenarios])
  // Which folders are expanded is part of the browsing position, so it lives here (not in the tree
  // component) and is kept for the browser session.
  const [expanded, setExpanded] = useState<string[]>(() => {
    const saved = readSession("expanded")
    if (Array.isArray(saved) && saved.every((path) => typeof path === "string")) return saved
    // Open the project, and the section with the most screens in it.
    return folderTree.children.flatMap((project) => {
      const sections = project.children.flatMap((child) => (child.label === "src" ? child.children : [child]))
      const busiest = sections
        .map((section) => ({
          section,
          count: scenarios.filter((s) => scenarioFolder(s).startsWith(`${section.path}/`)).length,
        }))
        .sort((a, b) => b.count - a.count)[0]
      return [project.path, `${project.path}/src`, ...(busiest?.count ? [busiest.section.path] : [])]
    })
  })
  useEffect(() => {
    writeSession("expanded", expanded)
  }, [expanded])
  const selectedScenarios = useMemo(
    () => scenarios.filter((s) => pathSelected(scenarioFolder(s), folders)),
    [folders, scenarios],
  )
  useEffect(() => {
    writeSession("folders", folders)
    // Mirrored into the URL too, so the address bar is always a shareable link to this folder
    // selection. `replaceState`, not `navigate`'s `pushState`: picking folders is filtering, not
    // moving to a new place, so it must not pile up Back-button stops.
    const params = new URLSearchParams(location.search)
    const encoded = encodeFolderRules(folders)
    if (encoded) params.set("folders", encoded)
    else params.delete("folders")
    history.replaceState(history.state, "", `${location.pathname}?${params}`)
    setQuery(params)
  }, [folders])
  const fullScreen = readView(query) === "screen"
  // The workbench stays mounted behind both preview sizes (including the canvas viewport).
  const mode = fullScreen ? (query.get("returnView") === "canvas" ? "canvas" : "gallery") : readView(query)
  const expandedId = query.get("preview") ?? undefined
  const selected = scenarios.find((s) => s.id === query.get("scenario"))
  const expandedScenario = scenarios.find((s) => s.id === expandedId)
  // The address bar always mirrors view, screen and folder selection, so this is just that URL
  // made explicit and copyable, rather than a separately maintained link.
  const shareUrl = useMemo(() => `${location.origin}${location.pathname}?${query}`, [query])
  const filtered = useMemo(
    () =>
      selectedScenarios.filter((s) =>
        `${s.title} ${s.id} ${s.description ?? ""} ${s.group}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [search, selectedScenarios],
  )
  // Preview browsing stays within the current selection. A screen opened by a direct link that is
  // not part of it (or with nothing selected) falls back to every screen in the project.
  const current = fullScreen ? selected : expandedScenario
  const pool = useMemo(
    () => (current && filtered.includes(current) ? filtered : scenarios),
    [filtered, scenarios, current],
  )
  const screenIndex = fullScreen && selected ? pool.indexOf(selected) : -1
  // On the full-size preview page, Left and Right step through the screens like the arrow buttons.
  useArrowKeys({
    onPrevious: screenIndex > 0 ? () => navigate("screen", pool[screenIndex - 1].id) : undefined,
    onNext:
      screenIndex >= 0 && screenIndex < pool.length - 1
        ? () => navigate("screen", pool[screenIndex + 1].id)
        : undefined,
  })
  const connections = useMemo(() => buildConnections(scenarios, data.transitions), [scenarios, data.transitions])
  const groups = useMemo(() => new Set(scenarios.map((s) => s.group)).size, [scenarios])
  // Failed screens: a live preview that failed to start this session, else a failed saved capture.
  const { issues, stale } = useMemo(() => {
    const found: Issue[] = []
    let staleCount = 0
    for (const scenario of filtered) {
      const live = liveIssues.get(scenario.id)
      const capture = thumbnailFor(scenario.id)
      if (live) found.push({ scenario, kind: "live", reason: live })
      else if (capture.state === "failed")
        found.push({ scenario, kind: "capture", reason: capture.reason ?? "Capture failed" })
      if (capture.state === "stale") staleCount++
    }
    return { issues: found, stale: staleCount }
    // `data` changes whenever captures do, which is when these counts can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, liveIssues, data])
  const updateQuery = useCallback((params: URLSearchParams, replace = false, state: object = {}) => {
    history[replace ? "replaceState" : "pushState"](state, "", `${location.pathname}?${params}`)
    setQuery(params)
  }, [])
  const setExpandedId = useCallback((id?: string) => {
    const params = new URLSearchParams(location.search)
    if (id) params.set("preview", id)
    else params.delete("preview")
    if (!id && history.state?.uixLayer === "preview") {
      backLayer(() => updateQuery(params, true))
      return
    }
    const ownsPreview = id && (!expandedId || history.state?.uixLayer === "preview")
    updateQuery(params, Boolean(expandedId) || !id, ownsPreview ? { uixLayer: "preview" } : {})
  }, [expandedId, updateQuery])
  const navigate = (view: View, id?: string) => {
    const leaving = readView(new URLSearchParams(location.search))
    setIssuesOpen(false)
    const params = new URLSearchParams()
    params.set("view", view)
    if (id) params.set("scenario", id)
    if (view === "screen") {
      params.set("returnView", mode)
      if (expandedId) params.set("preview", expandedId)
    }
    // The folder selection is independent of which view/screen is open, so it survives navigation.
    const folders = new URLSearchParams(location.search).get("folders")
    if (folders) params.set("folders", folders)
    // Stepping through full-size screens replaces the top layer, rather than adding Back stops.
    updateQuery(
      params,
      view === "screen" && leaving === "screen",
      view === "screen" ? { uixLayer: "screen" } : {},
    )
  }
  const returnFromLive = () => {
    const params = new URLSearchParams({ view: mode })
    if (expandedId) params.set("preview", expandedId)
    const fallback = () => updateQuery(params, true)
    if (history.state?.uixLayer === "screen") backLayer(fallback)
    // Direct links and refreshed pages still have a safe, local return destination.
    else fallback()
  }
  const returnToUI = () => {
    location.href = data.startPath
  }
  useEffect(() => {
    document.title = fullScreen && selected ? `${selected.title} · UI Explorer` : "UI Explorer"
  }, [fullScreen, selected])
  useEffect(() => {
    const restoration = history.scrollRestoration
    history.scrollRestoration = "manual"
    const pop = () => setQuery(new URLSearchParams(location.search))
    window.addEventListener("popstate", pop)
    return () => {
      history.scrollRestoration = restoration
      window.removeEventListener("popstate", pop)
    }
  }, [])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        !event.repeat &&
        !event.isComposing &&
        event.altKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.code === "KeyE"
      ) {
        event.preventDefault()
        event.stopPropagation()
        navigate("gallery")
      }
    }
    const message = (event: MessageEvent) => {
      const owned = Array.from(document.querySelectorAll("iframe")).some((frame) => frame.contentWindow === event.source)
      if (owned && event.origin === location.origin && event.data?.type === "uix:gallery") navigate("gallery")
    }
    document.addEventListener("keydown", shortcut, true)
    window.addEventListener("message", message)
    return () => {
      document.removeEventListener("keydown", shortcut, true)
      window.removeEventListener("message", message)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const liveHeader = fullScreen && selected ? (
    <header className="design-preview-bar">
      <Tooltip label={expandedId ? "Back to preview" : "All screens"} side="bottom">
        <Button variant="outline" size="icon" aria-label={expandedId ? "Back to preview" : "All screens"} onClick={returnFromLive}>
          <ArrowLeft size={16} />
        </Button>
      </Tooltip>
      <div className="design-preview-picker">
        <ScreenPicker screens={pool} value={selected.id} onSelect={(id) => navigate("screen", id)} />
      </div>
      <Tooltip label="Reset state" side="bottom">
        <Button variant="outline" size="icon" aria-label="Reset state" onClick={() => setRevision((value) => value + 1)}>
          <ArrowCounterClockwise size={16} />
        </Button>
      </Tooltip>
      <Tooltip label="Previous (←)" side="bottom">
        <Button
          variant="outline"
          size="icon"
          aria-label="Previous screen state"
          disabled={screenIndex === 0}
          onClick={() => navigate("screen", pool[screenIndex - 1].id)}
        >
          <ArrowLeft size={16} />
        </Button>
      </Tooltip>
      <Tooltip label="Next (→)" side="bottom">
        <Button
          variant="outline"
          size="icon"
          aria-label="Next screen state"
          disabled={screenIndex === pool.length - 1}
          onClick={() => navigate("screen", pool[screenIndex + 1].id)}
        >
          <ArrowRight size={16} />
        </Button>
      </Tooltip>
      <Tooltip label="Return to UI" side="bottom">
        <Button variant="outline" size="icon" aria-label="Return to UI" onClick={returnToUI}>
          <ArrowSquareOut size={16} />
        </Button>
      </Tooltip>
    </header>
  ) : undefined

  const searchRef = useRef<HTMLInputElement>(null)
  const exploring = data.jobs.crawl.status === "running"
  const nothingYet = scenarios.length === 0
  const workbench = (
    <main className="design-workbench">
      <header className="design-workbench-header">
        <Heading className="design-workbench-brand text-sm font-semibold">UI Explorer</Heading>
        <div className="design-workbench-header-actions">
          <JobStatus state={data} />
          {!isStatic && (
            <>
              <Tooltip label="Log in" side="bottom">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Log in"
                  onClick={() => {
                    setLoginPick(undefined)
                    setPicking(true)
                  }}
                >
                  <LockSimple size={18} aria-hidden="true" />
                </Button>
              </Tooltip>
              <Tooltip label="Logs" side="bottom">
                <Button variant="outline" size="icon" aria-label="Logs" onClick={() => setLogsOpen(true)}>
                  <TerminalWindow size={18} aria-hidden="true" />
                </Button>
              </Tooltip>
              <LogsPanel open={logsOpen} onOpenChange={setLogsOpen} />
            </>
          )}
          <ContextPanel
            label="Workspace overview"
            open={infoOpen}
            onOpenChange={setInfoOpen}
            className="design-workbench-popover"
            trigger={
              <Button variant="outline" size="icon" aria-label="Workspace overview" title="Workspace options">
                <DotsThree size={20} />
              </Button>
            }
          >
            <Heading level={2} className="text-base font-semibold">
              Workspace overview
            </Heading>
            {hasManual && hasCrawled ? (
              <div className="design-origin">
                <p className="design-workspace-label" id="screen-sources-label">Screen sources</p>
                <RadioGroup className="design-origin-options" aria-labelledby="screen-sources-label" value={origin} onValueChange={setChosenOrigin}>
                {(
                  [
                    ["manual", "Registered", "Screens and states defined in your project’s Explorer setup."],
                    ["crawled", "Discovered", "States found automatically by exploring your app."],
                    ["both", "All screens", "Registered and discovered screens together."],
                  ] as const
                ).map(([value, label, description]) => (
                  <div key={value} className="design-origin-card" data-selected={origin === value}>
                    <RadioOption
                      className="design-origin-option"
                      value={value}
                      aria-label={label}
                      aria-describedby={`screen-source-${value}-description`}
                    >
                      <span><strong>{label}</strong><small id={`screen-source-${value}-description`}>{description}</small></span>
                    </RadioOption>
                    {origin === value && <CatalogTotals label={label} screens={scenarios.length} sections={groups} connections={connections.length} />}
                  </div>
                ))}
                </RadioGroup>
              </div>
            ) : (
              <div className="design-origin">
                <p className="design-workspace-label">Screen source</p>
                <div className="design-origin-options design-origin-single">
                  <div className="design-origin-summary">
                    <strong>{hasManual ? "Registered" : "Discovered"}</strong>
                    <small>{hasManual ? "Screens and states registered in this project’s Explorer setup." : "States found automatically by exploring your app."}</small>
                  </div>
                  <CatalogTotals label={hasManual ? "Registered" : "Discovered"} screens={scenarios.length} sections={groups} connections={connections.length} />
                </div>
              </div>
            )}
            <div className="design-workspace-actions">
              {data.mode !== "manual" && !isStatic && !exploring && (
                <Button variant="outline" size="sm" aria-label="Explore this app" leftIcon={<ArrowsClockwise size={16} />} onClick={() => { setInfoOpen(false); void startCrawl() }}>
                  {nothingYet ? "Discover screens" : "Discover more screens"}
                </Button>
              )}
              <Button variant="outline" size="sm" leftIcon={<ArrowSquareOut size={16} />} onClick={returnToUI}>
                Return to UI
              </Button>
            </div>
            <CopyField id="explorer-share-link" label="Link to this view" value={shareUrl}
              copyLabel="Copy link" copiedLabel="Copied link" fallback="Select the link above and copy it with Ctrl+C (⌘C on Mac)." />
            {!isStatic && <FigmaConnection />}
            <details className="design-workspace-shortcuts"><summary><Command size={16} />Keyboard shortcuts</summary><p>/ or Ctrl/⌘ K · Search</p><p>Alt + Shift + E · Gallery</p><p>Alt + Shift + V · Switch view</p><p>Alt + Shift + R · Refresh selection</p></details>
          </ContextPanel>
        </div>
      </header>
      {(picking || loginMethod || loginCapture.watching) && (
        <LoginPickerBanner
          method={loginMethod}
          watching={loginCapture.watching}
          pastPassword={loginCapture.pastPassword}
          starting={autoLogin.starting}
          saving={loginCapture.saving}
          error={autoLogin.error}
          pick={loginPick}
          onCancel={() => {
            if (loginCapture.watching) loginCapture.cancel()
            setPicking(false)
            setLoginPick(undefined)
            setLoginMethod(undefined)
          }}
          onConfirm={() => {
            setPicking(false)
            setLoginMethod("choose")
          }}
          onChooseManual={() => {
            const scenario = data.scenarios.find((s) => s.id === loginPick)
            if (scenario) loginCapture.start(scenario, data.startPath)
            setLoginMethod("manual")
          }}
          onChooseAuto={() => setLoginMethod("auto")}
          onAutoSubmit={(username, password, headless) => {
            const scenario = data.scenarios.find((s) => s.id === loginPick)
            if (scenario) {
              void autoLogin.start(scenario, data.startPath, username, password, headless)
              setLoginMethod(undefined)
              setLoginPick(undefined)
            }
          }}
          onFinish={() => {
            void loginCapture.finish().then(() => {
              setLoginMethod(undefined)
              setLoginPick(undefined)
            })
          }}
        />
      )}
      <div className="design-workbench-layout">
        <FolderNavigator
          tree={folderTree}
          rules={folders}
          expanded={expanded}
          onExpandedChange={setExpanded}
          onToggle={(node) => setFolders((current) => toggleFolder(current, node))}
          onClear={() => setFolders([])}
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
          count={(path) => counts.get(path) ?? 0}
        />
        <div className="design-workbench-content">
          <div className="design-workbench-toolbar">
            <div className="design-workbench-views" role="group" aria-label="Explorer view">
              <Button
                className="design-view-tab"
                data-active={mode === "gallery"}
                aria-pressed={mode === "gallery"}
                variant="unstyled"
                onClick={() => navigate("gallery")}
              >
                <SquaresFour size={18} />
                Gallery
              </Button>
              <Button
                className="design-view-tab"
                data-active={mode === "canvas"}
                aria-pressed={mode === "canvas"}
                variant="unstyled"
                onClick={() => navigate("canvas")}
              >
                <Graph size={18} />
                Canvas
              </Button>
            </div>
            <div className="design-workbench-search">
              <MagnifyingGlass size={18} />
              <Input
                aria-label="Search screen states"
                ref={searchRef}
                placeholder="Search screens"
                value={search}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation()
                    if (search) setSearch("")
                    else event.currentTarget.blur()
                  }
                }}
                onChange={(event) => setSearch(event.target.value)}
              />
              <kbd className="design-search-shortcut" aria-hidden="true">/</kbd>
            </div>
          </div>
          {filtered.length > 0 && (
            <div className="design-workbench-sectionline">
              <span>{filtered.length} shown</span>
              {issues.length > 0 && (
                <Button
                  variant="link-danger"
                  leftIcon={<WarningCircle size={14} />}
                  onClick={() => setIssuesOpen(true)}
                >
                  {issues.length} failed
                </Button>
              )}
              {stale > 0 && (
                <Button variant="ghost-slim" onClick={() => setIssuesOpen(true)}>
                  {stale} stale
                </Button>
              )}
              <Button className="ml-auto" variant="ghost-slim" onClick={() => setScreenSelection(previous => new Set([...previous, ...filtered.map(s => s.id)]))}>
                Select visible
              </Button>
            </div>
          )}
          {exportScreens.length > 0 && (
            <div className="design-screen-selection-bar" role="region" aria-label="Screen selection">
              <span role="status">{exportScreens.length} selected</span>
              <FigmaExport scenarios={exportScreens} reviewSelection />
              <Button variant="ghost-slim" onClick={() => setScreenSelection(new Set())}>Clear selection</Button>
            </div>
          )}
          {nothingYet && !exploring ? (
            <section className="design-folder-empty" aria-label="Nothing explored yet">
              <div>
                <Compass size={32} />
              </div>
              <Heading level={2}>Nothing explored yet</Heading>
              {data.mode !== "manual" && (
                <Button variant="outline" onClick={() => void startCrawl()}>
                  Explore this app
                </Button>
              )}
            </section>
          ) : !folders.some((rule) => rule.selected) ? (
            <section className="design-folder-empty" aria-label="Choose folders">
              <div>
                <FolderSimple size={32} />
              </div>
              <Heading level={2}>Select a folder</Heading>
            </section>
          ) : !selectedScenarios.length ? (
            <section className="design-folder-empty" role="status" aria-label="No screens in the selected folders">
              <div>
                <FolderSimple size={32} />
              </div>
              <Heading level={2}>No screens here</Heading>
            </section>
          ) : !filtered.length ? (
            <section className="design-folder-empty" role="status" aria-label="No screens match">
              <div>
                <MagnifyingGlass size={32} />
              </div>
              <Heading level={2}>No matches</Heading>
              <Button variant="outline" onClick={() => setSearch("")}>
                Clear search
              </Button>
            </section>
          ) : mode === "canvas" ? (
            <Suspense
              fallback={
                <p role="status" className="p-8 text-fg-muted">
                  Loading…
                </p>
              }
            >
              <FlowCanvas scenarios={filtered} connections={connections} onOpen={setExpandedId} selectedIds={screenSelection} onSelect={setScreenSelected} />
            </Suspense>
          ) : (
            <RadioGroup
              value={loginPick}
              onValueChange={(value) => { if (picking) setLoginPick(value as string) }}
              render={<section className="design-screen-grid" aria-label="Screen gallery" />}
            >
              {filtered.map((s: Scenario) => (
                <article key={s.id} className="design-screen-card" data-selected={picking ? loginPick === s.id : screenSelection.has(s.id)}>
                  <div className="design-screen-card__preview">
                    <ScreenFrame scenario={s} compact />
                    {/* Text-free overlay: the thumbnail's status text stays outside the button's name. */}
                    <Button
                      className="design-screen-card__open"
                      aria-label={`Expand ${s.title}`}
                      onClick={() => setExpandedId(s.id)}
                    />
                  </div>
                  <div className="design-screen-card__body">
                    <div className="design-screen-card__heading">
                      {picking ? (
                        <ScreenSelectRadio title={s.title} value={s.id} />
                      ) : (
                        <ScreenSelect title={s.title} checked={screenSelection.has(s.id)} onChange={checked => setScreenSelected(s.id, checked)} />
                      )}
                      <Button className="design-screen-card__title" title={s.title} onClick={() => setExpandedId(s.id)}>
                        {s.title}
                      </Button>
                    </div>
                    <div className="design-screen-card__meta">
                      <span className="design-screen-card__path" title={scenarioSource(s)}>
                        {folderCrumb(scenarioSource(s))}
                      </span>
                      {isState(s) && <span className="design-state-pill design-state-pill--branch">State</span>}
                    </div>
                  </div>
                </article>
              ))}
            </RadioGroup>
          )}
        </div>
      </div>
      {issuesOpen && (issues.length > 0 || stale > 0) && (
        <IssuesPanel
          issues={issues}
          stale={stale}
          onClose={() => setIssuesOpen(false)}
          onOpenLive={(id) => navigate("screen", id)}
        />
      )}
    </main>
  )
  const previewScenario = fullScreen ? selected : expandedScenario
  // Keyboard shortcuts read the latest state through a ref, so the listener is attached once.
  const shortcutState = {
    previewScenario, filtered, scenarios, mode, exploring, navigate,
    live: !isStatic, crawl: !isStatic && data.mode !== "manual",
    reset: () => setRevision((value) => value + 1),
  }
  const latest = useRef(shortcutState)
  latest.current = shortcutState
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing) return
      const now = latest.current
      const typing = event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
      const focusSearch = () => { event.preventDefault(); searchRef.current?.focus(); searchRef.current?.select() }
      // Search: / (outside a text field) or Ctrl/Cmd + K (anywhere) while the workbench is visible.
      if (!now.previewScenario && ((event.key === "/" && !typing && !event.altKey && !event.ctrlKey && !event.metaKey) ||
        ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === "KeyK"))) return focusSearch()
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return
      if (event.code === "KeyF" && !now.previewScenario) return focusSearch()
      if (event.code === "KeyV" && !now.previewScenario) {
        event.preventDefault()
        now.navigate(now.mode === "gallery" ? "canvas" : "gallery")
      } else if (event.code === "KeyR") {
        event.preventDefault()
        if (now.previewScenario) {
          // In a preview: reset the active screen and refresh its thumbnail.
          now.reset()
          if (now.live) void startCapture([now.previewScenario.id])
        } else if (now.live) {
          // In the workbench: refresh the screens in the current selection (and search), or every screen when nothing is selected.
          const ids = (now.filtered.length ? now.filtered : now.scenarios).map((s) => s.id)
          if (ids.length) void startCapture(ids)
        }
      } else if (event.code === "KeyX" && now.crawl && !now.exploring) {
        event.preventDefault()
        void startCrawl()
      }
    }
    document.addEventListener("keydown", keydown, true)
    return () => document.removeEventListener("keydown", keydown, true)
  }, [])
  return (
    <>
      <CompactPreviewActivity.Provider value={!previewScenario}>{workbench}</CompactPreviewActivity.Provider>
      {previewScenario && (
        <ScreenLightbox
          key={data.revision}
          scenario={previewScenario}
          fullScreen={fullScreen}
          header={liveHeader}
          revision={revision}
          viewport={viewport}
          customWidth={customWidth}
          onCustomWidthChange={setCustomWidth}
          onViewportChange={setViewport}
          siblings={pool}
          onReset={() => setRevision((value) => value + 1)}
          onSelect={setExpandedId}
          onClose={() => (fullScreen ? returnFromLive() : setExpandedId(undefined))}
          onOpenLive={(id) => navigate("screen", id)}
        />
      )}
    </>
  )
}

export default function Explorer() {
  const data = useExplorerState()
  const failure = useExplorerFailure()
  if (!data)
    return (
      <p role={failure ? "alert" : "status"} className="design-loading">
        {failure ?? "Loading…"}
      </p>
    )
  return <Loaded data={data} />
}
