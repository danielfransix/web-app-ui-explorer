import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react"
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
import { Info } from "@phosphor-icons/react/dist/csr/Info"
import { FolderSimple } from "@phosphor-icons/react/dist/csr/FolderSimple"
import { SpinnerGap } from "@phosphor-icons/react/dist/csr/SpinnerGap"
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle"
import { X } from "@phosphor-icons/react/dist/csr/X"
import type { Scenario } from "../shared/types"
import { Button, ContextPanel, Heading, Input, Select, Tooltip } from "./ui"
import {
  cancelCapture,
  cancelCrawl,
  connections as buildConnections,
  isState,
  startCrawl,
  useExplorerFailure,
  useExplorerState,
  type ExplorerState,
} from "./data"
import ScreenFrame from "./ScreenFrame"
import FolderNavigator from "./FolderNavigator"
import ScreenLightbox from "./ScreenLightbox"
import useArrowKeys from "./useArrowKeys"
import IssuesPanel, { type Issue } from "./IssuesPanel"
import { usePreviewIssues } from "./previewIssues"
import { readSession, writeSession } from "./sessionState"
import { thumbnailFor } from "./thumbnailCache"
import { DEFAULT_CUSTOM_WIDTH, isCustomWidth, isViewportPreset, type ViewportPreset } from "./viewports"
import {
  buildFolderTree,
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
  const failed = crawl.status === "error" ? crawl : capture.status === "error" ? capture : undefined
  if (failed)
    return (
      <div className="design-job design-job--error" role="alert" title={failed.message}>
        <WarningCircle size={16} aria-hidden="true" />
        <span>{crawl.status === "error" ? "Exploring failed" : "Capture failed"}</span>
      </div>
    )
  return null
}

type Origin = "manual" | "crawled" | "both"

function Loaded({ data }: { data: ExplorerState }) {
  // Hand-written and explored scenarios can both exist; show the curated set unless there is none.
  const hasManual = data.scenarios.some((s) => s.origin === "manual")
  const hasCrawled = data.scenarios.some((s) => s.origin !== "manual")
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
  }, [folders])
  const fullScreen = readView(query) === "screen"
  // The workbench stays mounted behind both preview sizes (including the canvas viewport).
  const mode = fullScreen ? (query.get("returnView") === "canvas" ? "canvas" : "gallery") : readView(query)
  const expandedId = query.get("preview") ?? undefined
  const selected = scenarios.find((s) => s.id === query.get("scenario"))
  const expandedScenario = scenarios.find((s) => s.id === expandedId)
  const screenIndex = fullScreen && selected ? scenarios.indexOf(selected) : -1
  // On the full-size preview page, Left and Right step through the screens like the arrow buttons.
  useArrowKeys({
    onPrevious: screenIndex > 0 ? () => navigate("screen", scenarios[screenIndex - 1].id) : undefined,
    onNext:
      screenIndex >= 0 && screenIndex < scenarios.length - 1
        ? () => navigate("screen", scenarios[screenIndex + 1].id)
        : undefined,
  })
  const filtered = useMemo(
    () =>
      selectedScenarios.filter((s) =>
        `${s.title} ${s.description ?? ""} ${s.group}`.toLowerCase().includes(search.toLowerCase()),
      ),
    [search, selectedScenarios],
  )
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
        <Select
          aria-label="Jump to a screen state"
          value={selected.id}
          onChange={(event) => navigate("screen", event.target.value)}
        >
          <option value="">Choose a screen state</option>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {`${s.group} · ${s.title}`}
            </option>
          ))}
        </Select>
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
          onClick={() => navigate("screen", scenarios[screenIndex - 1].id)}
        >
          <ArrowLeft size={16} />
        </Button>
      </Tooltip>
      <Tooltip label="Next (→)" side="bottom">
        <Button
          variant="outline"
          size="icon"
          aria-label="Next screen state"
          disabled={screenIndex === scenarios.length - 1}
          onClick={() => navigate("screen", scenarios[screenIndex + 1].id)}
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

  const exploring = data.jobs.crawl.status === "running"
  const nothingYet = scenarios.length === 0
  const workbench = (
    <main className="design-workbench">
      <header className="design-workbench-header">
        <div className="flex items-center gap-3">
          <strong className="text-sm">UI Explorer</strong>
        </div>
        <div className="flex items-center gap-3">
          <JobStatus state={data} />
          {data.mode !== "manual" && !exploring && (
            <Tooltip label={nothingYet ? "Explore" : "Explore again"} side="bottom">
              <Button variant="ghost" size="icon" aria-label="Explore this app" onClick={() => void startCrawl()}>
                <ArrowsClockwise size={20} />
              </Button>
            </Tooltip>
          )}
          <ContextPanel
            label="Workspace overview"
            open={infoOpen}
            onOpenChange={setInfoOpen}
            className="design-workbench-popover"
            trigger={
              <Button variant="ghost" size="icon" aria-label="Workspace overview">
                <Info size={20} />
              </Button>
            }
          >
            <Heading level={2} className="text-base font-semibold">
              Workspace overview
            </Heading>
            {hasManual && hasCrawled && (
              <div className="design-origin" role="group" aria-label="Scenarios shown">
                {(
                  [
                    ["manual", "Curated"],
                    ["crawled", "Explored"],
                    ["both", "Both"],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    variant={origin === value ? "secondary-2" : "ghost"}
                    size="sm"
                    aria-pressed={origin === value}
                    onClick={() => setChosenOrigin(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            )}
            <div className="design-workbench-metrics mt-5">
              <div>
                <strong>{scenarios.length}</strong>
                <span>Screens</span>
              </div>
              <div>
                <strong>{groups}</strong>
                <span>Sections</span>
              </div>
              <div>
                <strong>{connections.length}</strong>
                <span>Connections</span>
              </div>
            </div>
            <div className="mt-5 flex items-center gap-2 border-t border-border pt-4 text-xs text-fg-subtle">
              <Command size={16} />
              <span>Alt + Shift + E · Gallery</span>
            </div>
          </ContextPanel>
          <Button variant="outline" size="sm" leftIcon={<ArrowSquareOut size={16} />} onClick={returnToUI}>
            Return to UI
          </Button>
        </div>
      </header>
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
            <div className="design-workbench-views">
              <Button
                className="design-view-tab"
                data-active={mode === "gallery"}
                variant="unstyled"
                onClick={() => navigate("gallery")}
              >
                <SquaresFour size={18} />
                Gallery
              </Button>
              <Button
                className="design-view-tab"
                data-active={mode === "canvas"}
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
                placeholder="Search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          {filtered.length > 0 && (
            <div className="design-workbench-sectionline">
              <span>{filtered.length}</span>
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
              <FlowCanvas scenarios={filtered} connections={connections} onOpen={setExpandedId} />
            </Suspense>
          ) : (
            <section className="design-screen-grid" aria-label="Screen gallery">
              {filtered.map((s: Scenario) => (
                <article key={s.id} className="design-screen-card">
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
                    <Button className="design-screen-card__title" onClick={() => setExpandedId(s.id)}>
                      {s.title}
                    </Button>
                    <div className="design-screen-card__meta">
                      <span className="design-screen-card__path" title={scenarioSource(s)}>
                        {folderCrumb(scenarioSource(s))}
                      </span>
                      {isState(s) && <span className="design-state-pill design-state-pill--branch">State</span>}
                    </div>
                  </div>
                </article>
              ))}
            </section>
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
  return (
    <>
      {workbench}
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
          siblings={filtered}
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
