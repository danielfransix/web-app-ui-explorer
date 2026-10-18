import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createServer } from "vite"
import { captureDesigns } from "../dist/node/index.js"
import uiExplorer from "../dist/node/vite.js"

// Finds the first node (depth-first) matching a predicate, anywhere in the captured tree.
function find(node, predicate) {
  if (predicate(node)) return node
  for (const child of node.children) {
    const found = find(child, predicate)
    if (found) return found
  }
  return undefined
}

test("captureDesigns walks one scenario into a structured, per-width design tree from a single page load", { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-design-capture-"))
  fs.writeFileSync(
    path.join(root, "index.html"),
    `<!doctype html><html><head><style>
      body { margin: 0; font-family: Arial, sans-serif; }
      :root { --color-primary-600: #3366ff; }
      .card { margin: 20px; padding: 16px; background: var(--color-primary-600); border: 2px solid #112244;
        border-radius: 12px; box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3); }
      .card h1 { font-size: 24px; color: #ffffff; margin: 0; }
      .mixed { border-top: 2px solid #000; border-right: 4px solid #333; border-bottom: 2px solid #000; border-left: 2px solid #000; height: 10px; }
      .sidebar { width: 200px; height: 40px; background: #eeeeee; }
      .positioning-slot { position:relative; height:0; width:200px; }
      .positioning-slot aside { position:absolute; top:0; right:0; width:120px; height:100px; }
      .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
      @media (max-width: 600px) { .sidebar { display: none; } }
    </style></head><body>
      <div style="display:contents"><div class="card"><h1>Hello Design</h1></div></div>
      <p>Mixed <strong>formatted</strong> text</p>
      <svg width="20" height="20" aria-hidden="true" viewBox="0 0 20 20"><path d="M0 0L20 20" stroke="currentColor" /></svg>
      <div style="background:oklch(60% 0.2 250);height:12px">Modern color</div>
      <div class="mixed"></div>
      <div style="height:10px;border-bottom:1px solid #112244"></div>
      <div style="height:20px;width:36px;border-radius:calc(infinity * 1px)"></div>
      <div class="sidebar">Sidebar content</div>
      <div class="positioning-slot"><aside>Steps panel</aside></div>
      <span class="sr-only">Hidden mirrored value</span>
      <sup style="line-height:0;color:red">*</sup>
      <input value="Padded input" style="padding:12px 16px;border:1px solid #ccc;height:50px;box-sizing:border-box">
      <div style="height:40px;overflow:auto"><div style="height:100px">Scrollable content</div></div>
      <svg width="16" height="16" style="color:oklch(60% 0.2 250)" viewBox="0 0 256 256"><path d="M0 0L256 256" stroke="currentColor"/></svg>
    </body></html>`,
  )
  const scenario = { id: "screen-0", title: "Screen 0", group: "Screens", source: "src/Home.tsx", actions: [] }
  const server = await createServer({
    root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
    plugins: [uiExplorer({ mode: "manual", autoCapture: false, scenarios: [scenario] })],
  })
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    const [wide, narrow] = await captureDesigns({ baseUrl: base, startPath: "/", scenario, widths: [1200, 500] })

    assert.equal(wide.scenarioId, "screen-0")
    assert.equal(wide.width, 1200)
    assert.equal(narrow.width, 500)
    assert.deepEqual(wide.root.rect, { x:0, y:0, width:1200, height:900 }, "a screen export uses the visible viewport rather than document scroll height")
    assert.equal(wide.root.clipsContent, true)
    const superscript=find(wide.root,node=>node.tag === "sup")
    assert.ok(Object.values(superscript.textRect).every(Number.isFinite),"zero-line-height superscripts retain finite text coordinates")
    assert.ok(superscript.text.lineHeight > 0,"superscript glyphs have a drawable line box")
    assert.ok(find(wide.root, (node) => node.text?.content === "Steps panel"), "visible absolute descendants survive zero-height parents")
    assert.ok(!find(wide.root, (node) => node.text?.content === "Hidden mirrored value"), "screen-reader-only values do not overlap the visible design")
    const input = find(wide.root, (node) => node.text?.content === "Padded input")
    assert.equal(input.textRect.x - input.rect.x, 17)
    assert.ok(input.textRect.y > input.rect.y, "input text respects vertical alignment")
    assert.ok(find(wide.root, (node) => node.rect.height === 40 && node.clipsContent), "scroll clipping is retained")
    assert.ok(!find(wide.root, (node) => node.svg?.includes("oklch(")), "SVG paints use explicit colors supported by the destination")
    assert.deepEqual(find(wide.root, (node) => node.stroke?.widths)?.stroke.widths, {top:0,right:0,bottom:1,left:0}, "one-sided dividers retain their edge weights")
    assert.equal(find(wide.root, (node) => node.rect.width === 36 && node.rect.height === 20)?.radius,9999,"large scientific-notation pill radii survive capture")

    // Text leaf: content, size and color read from the live computed style.
    const heading = find(wide.root, (node) => node.text?.content === "Hello Design")
    assert.ok(heading, "the heading text was captured")
    assert.ok(find(wide.root, (node) => node.text?.content === "Mixed"), "mixed text around nested markup is preserved")
    assert.ok(find(wide.root, (node) => node.svg?.includes("<path")), "decorative SVGs are visible design content")
    assert.match(find(wide.root, (node) => node.text?.content === "Modern color").fills[0].color, /^rgb\(/, "modern CSS colors become explicit sRGB paints")
    assert.equal(heading.text.fontSize, 24)
    assert.equal(heading.text.color, "rgb(255, 255, 255)")

    // Uniform fill, border and radius resolve to one clean value each.
    const card = find(wide.root, (node) => node.tag === "div" && node.fills.some((fill) => fill.type === "solid"))
    assert.ok(card, "the card's fill was captured")
    assert.deepEqual(card.fills, [{ type: "solid", color: "rgb(51, 102, 255)", token: "--color-primary-600" }])
    assert.deepEqual(card.stroke, { color: "rgb(17, 34, 68)", width: 2, token: undefined })
    assert.equal(card.radius, 12)
    assert.equal(card.shadow?.length, 1)
    assert.equal(card.shadow[0].blur, 10)
    assert.equal(card.shadow[0].color, "rgba(0, 0, 0, 0.3)")

    // A mixed per-side border is a documented gap: skipped rather than guessed at.
    // (10px content height + 2px top/bottom borders each, default content-box sizing.)
    const mixed = find(wide.root, (node) => node.tag === "div" && node.rect.height === 14)
    assert.ok(mixed, "the mixed-border box was walked")
    assert.equal(mixed.stroke, undefined, "a non-uniform border is left unset, not approximated")

    // The same scenario at a narrower width reflects the app's own responsive behaviour: the sidebar
    // disappears (never reloaded - the heading above is still there, from the very same page load).
    assert.ok(find(wide.root, (node) => node.rect.width === 200 && node.rect.height === 40), "sidebar visible at 1200px")
    assert.ok(!find(narrow.root, (node) => node.rect.width === 200 && node.rect.height === 40), "sidebar hidden at 500px")
    assert.ok(find(narrow.root, (node) => node.text?.content === "Hello Design"), "heading still present at 500px")
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
