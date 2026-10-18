import { chromium } from "playwright"
import { previewPath, STATUS_ATTRIBUTE } from "../shared/preview"
import type { DesignCapture, Scenario, UixRuntime } from "../shared/types"
import { componentSourceResolver } from "./component-sources"

// The foundation of the Figma export system: for one scenario, produce one structured capture per
// requested width, all from a single page load. Widths of the same scenario must agree on anything the
// app itself doesn't vary by width (random ids, "first visit" state), so the page is never reloaded
// between them - only resized in place, settled, and re-walked.

type W = Window & { __uix?: UixRuntime }

export type CaptureDesignsOptions = {
  baseUrl: string
  startPath: string
  scenario: Scenario
  /** Pixel widths to capture, in the order given. At least one is required. */
  widths: number[]
  height?: number
  storageState?: string
  blockWrites?: boolean
  projectRoot?: string
  signal?: AbortSignal
}

const DEFAULT_HEIGHT = 900

export async function captureDesigns(options: CaptureDesignsOptions): Promise<DesignCapture[]> {
  options.signal?.throwIfAborted()
  if (!options.widths.length || options.widths.some((width) => !Number.isInteger(width) || width < 1 || width > 7680))
    throw new Error("captureDesigns needs widths from 1 to 7680 pixels")
  const height = options.height ?? DEFAULT_HEIGHT
  const resolveComponents = options.projectRoot ? componentSourceResolver(options.projectRoot) : undefined
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] })
  const abort = () => { void browser.close().catch(() => {}) }
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    options.signal?.throwIfAborted()
    const context = await browser.newContext({ storageState: options.storageState })
    if (options.blockWrites ?? true) {
      await context.route("**/*", (route) => {
        const method = route.request().method()
        if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.continue()
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      })
    }
    const page = await context.newPage()
    await page.clock.setFixedTime(new Date())
    // Forces the runtime active even on a scenario with its own `url` - a host that routes previews
    // itself (reaching a step through its own app routing rather than the `?__uix=` replay recipe) never
    // sets the `__uix` query param the runtime normally keys off, so without this `window.__uix` would
    // never be installed at all and every call below would throw on `undefined`.
    await page.addInitScript(() => {
      ;(window as unknown as { __UIX_FORCE?: boolean }).__UIX_FORCE = true
    })
    await page.setViewportSize({ width: options.widths[0], height })
    await page.goto(new URL(previewPath(options.scenario, options.startPath), options.baseUrl).toString(), {
      waitUntil: "domcontentloaded",
    })
    await page.waitForFunction(() => !!(window as W).__uix, undefined, { timeout: 30_000 })
    if (!options.scenario.url) {
      // The standard replay-driven flow: wait for the explicit ready/error signal the runtime sets once
      // the recorded actions have replayed.
      await page.waitForFunction(
        (attribute) => document.documentElement.getAttribute(attribute) !== null,
        STATUS_ATTRIBUTE,
        { timeout: 30_000 },
      )
      const status = await page.evaluate(
        (attribute) => document.documentElement.getAttribute(attribute) ?? "",
        STATUS_ATTRIBUTE,
      )
      if (status !== "ready") throw new Error(status.replace(/^error:\s*/, "") || "The preview did not start")
    } else {
      // A scenario with its own `url` reaches its state through the host's own routing - there's no
      // explicit ready signal to wait for, so this falls back to "has rendered something".
      await page.waitForFunction(() => !!document.body && document.body.innerText.trim().length > 0, undefined, {
        timeout: 20_000,
      })
    }

    await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" })
    const results: DesignCapture[] = []
    for (const width of new Set(options.widths)) {
      await page.setViewportSize({ width, height })
      // Settle first (animations/timers/requests the resize itself may have triggered), then give any
      // newly-visible images and fonts revealed by this width a chance to finish loading before capturing.
      await page.evaluate(() => (window as W).__uix!.settle(150, 2500))
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
      // Lazy routes can remain on their fallback after replay and a brief network-idle window.
      // An explicit loading marker must clear before we capture a completed screen.
      await page.waitForFunction(() => !Array.from(document.querySelectorAll('[data-uix-loading], [aria-busy="true"]')).some(element => {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
      }), undefined, { timeout: 30_000 }).catch(error => {
        throw new Error(`Screen "${options.scenario.id}" is still loading at ${width}px: ${error instanceof Error ? error.message : String(error)}`)
      })
      await page.evaluate(() => (window as W).__uix!.settle(150, 2500))
      await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready)
      const warnings = await page.evaluate(async () => {
        const warnings: string[] = []
        await Promise.all(Array.from(document.images).filter((img) => img.getBoundingClientRect().width > 0).map(async (img) => {
          img.loading = "eager"
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([img.decode(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 5000) })])
          } catch { warnings.push(`Image did not load: ${img.currentSrc || img.src}`) }
          finally { clearTimeout(timer) }
        }))
        return warnings
      })
      const root = await page.evaluate(() => (window as W).__uix!.captureDesign())
      if (!root) throw new Error(`Nothing visible to capture at width ${width}`)
      resolveComponents?.(root)
      // Fetch images from the source browser context, where the app's cookies and relative URLs work.
      // The resulting data URLs do not depend on a separate Figma sandbox's CORS policy.
      const embedImages = async (node: typeof root): Promise<void> => {
        for (const fill of node.fills) if (fill.type === "image" && !fill.src.startsWith("data:")) {
          try {
            const result = await context.request.get(new URL(fill.src, page.url()).toString(), { timeout: 5000 })
            if (!result.ok()) throw new Error(`HTTP ${result.status()}`)
            const bytes = await result.body()
            if (node.tag === "img" && result.headers()["content-type"]?.includes("svg")) {
              // An <img>'s CSS size can differ from the SVG file's intrinsic viewport. Encode the
              // actual viewport so an editable vector import scales its paths, not only its frame.
              node.svg = await page.evaluate(({ svg, width, height }) => {
                const document = new DOMParser().parseFromString(svg, "image/svg+xml")
                const root = document.documentElement
                root.setAttribute("width", String(width)); root.setAttribute("height", String(height))
                return new XMLSerializer().serializeToString(root)
              }, { svg: bytes.toString("utf8"), width: node.rect.width, height: node.rect.height })
              node.fills = node.fills.filter((item) => item !== fill)
            } else fill.src = `data:${result.headers()["content-type"] ?? "image/png"};base64,${bytes.toString("base64")}`
          } catch { warnings.push(`Could not embed image: ${fill.src}`) }
        }
        await Promise.all(node.children.map(embedImages))
      }
      await embedImages(root)
      results.push({ scenarioId: options.scenario.id, width, height, capturedAt: new Date().toISOString(), root, warnings })
    }
    return results
  } finally {
    options.signal?.removeEventListener("abort", abort)
    await browser.close().catch(() => {})
  }
}
