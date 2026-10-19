import fs from "node:fs"
import path from "node:path"
import { chromium } from "playwright"
import { previewPath, STATUS_ATTRIBUTE } from "../shared/preview"
import type { Scenario, UixRuntime } from "../shared/types"

// One JPEG per scenario, taken from the same preview page the explorer embeds. A manifest records the
// revision of the app the images came from, so the explorer can ignore them as soon as the source changes.

export type ThumbnailManifest = {
  revision: string
  capturedAt: string
  viewport: { width: number; height: number }
  items: Record<string, { file: string }>
  failed: Record<string, string>
}

export type CaptureOptions = {
  baseUrl: string
  startPath: string
  scenarios: Scenario[]
  /** Folder for the images and manifest.json. */
  outDir: string
  /** Revision of the source being captured, from the plugin. */
  revision: string
  /** Capture only these scenario ids. Others keep their image if it is of the same revision. */
  only?: string[]
  concurrency?: number
  storageState?: string
  blockWrites?: boolean
  signal?: AbortSignal
  log?: (line: string) => void
  onProgress?: (progress: { done: number; total: number; last?: string }) => void
}

const VIEWPORT = { width: 1280, height: 900 } // matches the thumbnail aspect ratio in the explorer

export function readManifest(outDir: string): ThumbnailManifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8"))
  } catch {
    return undefined
  }
}

export async function capture(options: CaptureOptions): Promise<ThumbnailManifest> {
  const log = options.log ?? (() => {})
  fs.mkdirSync(options.outDir, { recursive: true })
  const previous = readManifest(options.outDir)
  // A partial run keeps the other captures only while they belong to the same revision.
  const keep = options.only && previous?.revision === options.revision ? previous : undefined
  const items: ThumbnailManifest["items"] = { ...(keep?.items ?? {}) }
  const failed: ThumbnailManifest["failed"] = { ...(keep?.failed ?? {}) }
  const wanted = new Set(options.only)
  const targets = options.scenarios.filter((scenario) => !options.only || wanted.has(scenario.id))

  // Written as it goes, so cards show their pictures while the rest are still being taken.
  const writeManifest = () => {
    const manifest: ThumbnailManifest = {
      revision: options.revision,
      capturedAt: new Date().toISOString(),
      viewport: VIEWPORT,
      items,
      failed,
    }
    fs.writeFileSync(path.join(options.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  }
  let lastWrite = 0
  const writeSoon = () => {
    if (Date.now() - lastWrite < 1500) return
    lastWrite = Date.now()
    writeManifest()
  }

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] })
  let next = 0
  let done = 0
  const work = async () => {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      storageState: options.storageState,
    })
    if (options.blockWrites ?? true) {
      await context.route("**/*", (route) => {
        const method = route.request().method()
        if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.continue()
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      })
    }
    try {
      while (next < targets.length && !options.signal?.aborted) {
        const scenario = targets[next++]
        const page = await context.newPage()
        try {
          if (scenario.replayViewport) await page.setViewportSize(scenario.replayViewport)
          await page.goto(new URL(previewPath(scenario, options.startPath), options.baseUrl).toString(), {
            waitUntil: "domcontentloaded",
          })
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
          if (scenario.replayViewport) {
            await page.setViewportSize(VIEWPORT)
            await page.evaluate(() => (window as Window & { __uix?: UixRuntime }).__uix!.settle(150, 1500))
          }
          await page.waitForTimeout(250) // let entrance animations finish
          const file = `${scenario.id}.jpg`
          await page.screenshot({ path: path.join(options.outDir, file), type: "jpeg", quality: 82 })
          items[scenario.id] = { file }
          delete failed[scenario.id]
          log(`captured ${scenario.id}`)
        } catch (error) {
          failed[scenario.id] = String(error instanceof Error ? error.message : error).split("\n")[0]
          delete items[scenario.id]
          fs.rmSync(path.join(options.outDir, `${scenario.id}.jpg`), { force: true })
          log(`FAILED   ${scenario.id}: ${failed[scenario.id]}`)
        } finally {
          await page.close().catch(() => {})
          done++
          writeSoon()
          options.onProgress?.({ done, total: targets.length, last: scenario.title })
        }
      }
    } finally {
      await context.close().catch(() => {})
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, work))
  } finally {
    await browser.close().catch(() => {})
  }

  return writeManifest()
}
