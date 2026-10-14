import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  BaseEdge,
  MarkerType,
  useNodesState,
  useReactFlow,
  useStore,
  type Node,
  type NodeProps,
  type Edge,
  type EdgeProps,
} from "@xyflow/react"
import ELK from "elkjs/lib/elk-api.js"
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url"
import type { ElkNode } from "elkjs/lib/elk-api"
import { ArrowsOutSimple } from "@phosphor-icons/react/dist/csr/ArrowsOutSimple"
import { Plus } from "@phosphor-icons/react/dist/csr/Plus"
import { Minus } from "@phosphor-icons/react/dist/csr/Minus"
import { ArrowCounterClockwise } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise"
import { Button, Tooltip } from "./ui"
import type { Scenario, Transition } from "../shared/types"
import { folderCrumb, scenarioSource } from "./folderModel"
import ScreenFrame from "./ScreenFrame"
import "@xyflow/react/dist/style.css"

const WIDTH = 336
const HEIGHT = 284
// ELK reserves room for each edge label in the layout, so it needs the label's rendered size. This is
// an estimate for the 12px label font plus the chip padding.
const LABEL_CHAR_WIDTH = 7
const LABEL_PADDING = 20
const LABEL_HEIGHT = 24
// Below this zoom a card shows only its title: the thumbnails would be unreadably small and, for screens
// without a cached capture, each one is a whole app running in an iframe.
const LIVE_ZOOM = 0.18
// One layout engine for the page, running in a worker so arranging many screens never blocks the canvas.
let elk: InstanceType<typeof ELK> | undefined
const layoutEngine = () => (elk ??= new ELK({ workerUrl: elkWorkerUrl }))
const OpenPreview = createContext<(id: string) => void>(() => {})
type ScreenNodeType = Node<{ scenario: Scenario; crumb: string }, "screen">
type RoutedEdge = Edge<{
  path: string
  x: number
  y: number
}, "elk">
type CanvasProps = {
  scenarios: Scenario[]
  connections: Transition[]
  onOpen: (id: string) => void
}

// Subscribes to a boolean, not the viewport, so a card re-renders when it crosses the threshold rather
// than on every frame of a zoom or pan.
const ScreenNode = memo(function ScreenNode({
  data,
}: NodeProps<ScreenNodeType>) {
  const open = useContext(OpenPreview)
  const showPreview = useStore((state) => state.transform[2] >= LIVE_ZOOM)
  const s = data.scenario
  return (
    <article className="design-flow-node">
      <Handle type="target" position={Position.Left} id="in" />
      <div className="design-screen-card__preview nodrag">
        {showPreview ? (
          <ScreenFrame scenario={s} compact />
        ) : (
          <div className="design-flow-overview" aria-hidden="true">
            <span>{s.title}</span>
            <small>Zoom in for live UI</small>
          </div>
        )}
        {/* Text-free overlay: the thumbnail's status text stays outside the button's name. */}
        <Button
          className="design-screen-card__open nodrag"
          aria-label={`Expand ${s.title}`}
          onClick={() => open(s.id)}
        />
      </div>
      <Button
        className="design-flow-node__title nodrag"
        title={data.crumb}
        onClick={() => open(s.id)}
      >
        {s.title}
      </Button>
      <Handle type="source" position={Position.Right} id="out" />
    </article>
  )
})

function ZoomReadout() {
  const percent = useStore((state) => Math.round(state.transform[2] * 100))
  return (
    <output aria-label="Canvas zoom" className="design-flow-zoom">
      {percent}%
    </output>
  )
}

function LayoutEdge(props: EdgeProps<RoutedEdge>) {
  if (!props.data) return null
  return (
    <BaseEdge
      id={props.id}
      path={props.data.path}
      markerEnd={props.markerEnd}
      label={props.label}
      labelX={props.data.x}
      labelY={props.data.y}
      labelStyle={{ fill: "var(--color-slate-500)" }}
      labelBgStyle={{ fill: "var(--color-white)" }}
      labelBgPadding={[6, 4]}
      labelBgBorderRadius={4}
    />
  )
}
// The centre of the longest straight run of an edge. Orthogonal routes bend, so the midpoint of the
// point list (or of the whole path) can land on a corner or at the arrowhead beneath the target node.
function labelAnchor(points: { x: number; y: number }[]) {
  let best = { x: points[0].x, y: points[0].y, length: -1 }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length > best.length)
      best = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, length }
  }
  return best
}
const nodeTypes = { screen: ScreenNode }
const edgeTypes = { elk: LayoutEdge }

// Long control labels would crowd the canvas; the full text is on the card.
const shortLabel = (label?: string) => (label && label.length > 26 ? `${label.slice(0, 25)}…` : label)

function Canvas(props: CanvasProps) {
  const { scenarios, onOpen } = props
  const [nodes, setNodes, onNodesChange] = useNodesState<ScreenNodeType>([])
  const [edges, setEdges] = useState<RoutedEdge[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState("")
  const [revision, setRevision] = useState(0)
  const flow = useReactFlow<ScreenNodeType, RoutedEdge>()
  // The layout depends on which screens are shown, not on the identity of the array, so typing in the
  // search box or re-rendering the workbench does not trigger another layout.
  const idKey = `${scenarios.map((s) => s.id).join("|")}#${props.connections.length}`
  const latest = useRef({ scenarios, flow, connections: props.connections })
  latest.current = { scenarios, flow, connections: props.connections }
  useEffect(() => {
    const { scenarios, flow } = latest.current
    const ids = new Set(scenarios.map((s) => s.id))
    let active = true
    setBusy(true)
    setError("")
    const connections = latest.current.connections
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({ ...edge, label: shortLabel(edge.label) }))
    layoutEngine()
      .layout<ElkNode>({
        id: "hiring-experience",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "RIGHT",
          "elk.edgeRouting": "ORTHOGONAL",
          "elk.spacing.nodeNode": "56",
          "elk.layered.spacing.nodeNodeBetweenLayers": "96",
          "elk.edgeLabels.inline": "true",
          "elk.layered.edgeLabels.centerLabelPlacementStrategy": "MEDIAN_LAYER",
        },
        children: scenarios.map((s) => ({
          id: s.id,
          width: WIDTH,
          height: HEIGHT,
          layoutOptions: { "elk.portConstraints": "FIXED_POS" },
          ports: [
            { id: `${s.id}-in`, x: 0, y: HEIGHT / 2, width: 1, height: 1 },
            { id: `${s.id}-out`, x: WIDTH, y: HEIGHT / 2, width: 1, height: 1 },
          ],
        })),
        edges: connections.map((edge, i) => ({
          id: `edge-${i}`,
          sources: [`${edge.source}-out`],
          targets: [`${edge.target}-in`],
          labels: edge.label
            ? [
                {
                  id: `edge-${i}-label`,
                  text: edge.label,
                  width: edge.label.length * LABEL_CHAR_WIDTH + LABEL_PADDING,
                  height: LABEL_HEIGHT,
                  layoutOptions: { "elk.edgeLabels.placement": "CENTER" },
                },
              ]
            : [],
        })),
      })
      .then((graph) => {
        if (!active) return
        const positions = new Map(graph.children?.map((node) => [node.id, node]))
        const routes = new Map(graph.edges?.map((edge) => [edge.id, edge]))
        setNodes(
          scenarios.map((s) => {
            const positioned = positions.get(s.id)
            return {
              id: s.id,
              type: "screen",
              position: { x: positioned?.x ?? 0, y: positioned?.y ?? 0 },
              width: WIDTH,
              height: HEIGHT,
              data: { scenario: s, crumb: folderCrumb(scenarioSource(s)) },
            }
          }),
        )
        setEdges(
          connections.flatMap((edge, i) => {
            const routed = routes.get(`edge-${i}`)
            const section = routed?.sections?.[0]
            if (!section) return []
            const placed = routed?.labels?.[0]
            const points = [
              section.startPoint,
              ...(section.bendPoints ?? []),
              section.endPoint,
            ]
            const middle =
              placed?.x !== undefined && placed.y !== undefined
                ? {
                    x: placed.x + (placed.width ?? 0) / 2,
                    y: placed.y + (placed.height ?? 0) / 2,
                  }
                : labelAnchor(points)
            return [
              {
                id: `edge-${i}`,
                type: "elk" as const,
                source: edge.source,
                target: edge.target,
                sourceHandle: "out",
                targetHandle: "in",
                label: edge.label,
                markerEnd: {
                  type: MarkerType.ArrowClosed,
                  color: "var(--color-slate-350)",
                },
                data: {
                  path: points
                    .map(
                      (point, index) =>
                        `${index ? "L" : "M"} ${point.x} ${point.y}`,
                    )
                    .join(" "),
                  x: middle.x,
                  y: middle.y,
                },
              },
            ]
          }),
        )
        setBusy(false)
        requestAnimationFrame(() => {
          if (active) void flow.fitView({ padding: 0.12, duration: 300 })
        })
      })
      .catch((reason) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "Layout failed")
          setBusy(false)
        }
      })
    return () => {
      active = false
    }
  }, [idKey, setNodes, revision])
  return (
    <OpenPreview.Provider value={onOpen}>
      <section
        className="design-flow-canvas"
        aria-label="Connected screen canvas"
        data-layout-ready={!busy}
      >
        <ReactFlow<ScreenNodeType, RoutedEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          nodesDraggable={false}
          nodesConnectable={false}
          minZoom={0.05}
          maxZoom={1.6}
          onlyRenderVisibleElements
          onNodeDoubleClick={(_, node) => onOpen(node.id)}
          deleteKeyCode={null}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={2}
            color="var(--color-slate-400)"
          />
        </ReactFlow>
        <div className="design-flow-controls">
          <Button
            variant="outline"
            size="icon"
            aria-label="Zoom out"
            onClick={() => void flow.zoomOut({ duration: 200 })}
          >
            <Minus size={16} />
          </Button>
          <ZoomReadout />
          <Button
            variant="outline"
            size="icon"
            aria-label="Zoom in"
            onClick={() => void flow.zoomIn({ duration: 200 })}
          >
            <Plus size={16} />
          </Button>
          <span className="h-6 border-l border-border" />
          <Tooltip label="Fit all">
            <Button
              variant="outline"
              size="icon"
              aria-label="Fit all"
              onClick={() =>
                void flow.fitView({ padding: 0.12, duration: 300 })
              }
            >
              <ArrowsOutSimple size={16} />
            </Button>
          </Tooltip>
          <Tooltip label="Auto-layout">
            <Button
              variant="outline"
              size="icon"
              aria-label="Auto-layout"
              onClick={() => setRevision((value) => value + 1)}
            >
              <ArrowCounterClockwise size={16} />
            </Button>
          </Tooltip>
        </div>
        {busy && (
          <div className="design-flow-status" role="status">
            Arranging…
          </div>
        )}
        {error && (
          <div className="design-flow-status text-red-600" role="alert">
            Layout unavailable: {error}
          </div>
        )}
      </section>
    </OpenPreview.Provider>
  )
}

export default function FlowCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  )
}
