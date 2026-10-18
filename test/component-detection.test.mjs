import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createServer } from "vite"
import { captureDesigns } from "../dist/node/index.js"
import uiExplorer from "../dist/node/vite.js"
import { compile } from "svelte/compiler"
import { build as buildAstro } from "astro"

// React and Vue need to resolve bare imports ("react", "vue") against this project's own node_modules,
// which only happens if the fixture lives inside the project tree - os.tmpdir() is outside it.
const fixturesRoot = path.join(import.meta.dirname, "fixtures")
const tempFixture = (prefix) => fs.mkdtempSync(path.join(fixturesRoot, prefix))

test("Astro: scoped component identities are detected in real prerendered compiler output", { timeout: 60_000 }, async () => {
  const root = tempFixture("uix-real-astro-")
  const scenario = { id: "s", title: "S", group: "G", actions: [] }
  const previousEnvironment = process.env.NODE_ENV
  try {
    fs.mkdirSync(path.join(root, "src", "pages"), { recursive: true })
    fs.mkdirSync(path.join(root, "src", "components"), { recursive: true })
    fs.writeFileSync(path.join(root, "src", "components", "UserCard.astro"), '<section>Real Astro card</section><style>section { color: blue; }</style>')
    fs.writeFileSync(path.join(root, "src", "pages", "index.astro"), '---\nimport UserCard from "../components/UserCard.astro";\n---\n<html><body><UserCard /></body></html>')
    await buildAstro({ root, configFile: false, logLevel: "silent", devToolbar: { enabled: false }, vite: { ssr: { noExternal: ["cookie"] } } })
    if (previousEnvironment === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousEnvironment
    await withServer(path.join(root, "dist"), [scenario], async (base) => {
      const [capture] = await captureDesigns({ baseUrl: base, startPath: "/", scenario, widths: [800] })
      assert.ok(find(capture.root, (node) => node.component?.framework === "astro"), "real Astro scope identity detected")
    })
  } finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousEnvironment
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function find(node, predicate) {
  if (predicate(node)) return node
  for (const child of node.children) {
    const found = find(child, predicate)
    if (found) return found
  }
  return undefined
}

async function withServer(root, scenarios, run, plugins = []) {
  const server = await createServer({
    root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
    plugins: [...plugins, uiExplorer({ mode: "manual", autoCapture: false, scenarios })],
  })
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    await run(base)
  } finally {
    await server.close()
  }
}

test("Svelte: development metadata is detected on a component compiled by the real Svelte compiler", { timeout: 60_000 }, async () => {
  const root = tempFixture("uix-real-svelte-")
  const scenario = { id: "s", title: "S", group: "G", actions: [] }
  try {
    fs.writeFileSync(path.join(root, "UserCard.svelte"), '<div><span>Real Svelte card</span></div>')
    fs.writeFileSync(path.join(root, "index.html"), '<div id="root"></div><script type="module" src="/main.js"></script>')
    fs.writeFileSync(path.join(root, "main.js"), 'import { mount } from "svelte"; import UserCard from "./UserCard.svelte"; mount(UserCard, { target: document.getElementById("root") });')
    await withServer(root, [scenario], async (base) => {
      const [capture] = await captureDesigns({ baseUrl: base, startPath: "/", scenario, widths: [800] })
      const component = find(capture.root, (node) => node.component?.framework === "svelte")
      assert.ok(component, "real compiled component detected")
      assert.match(component.component.sourceFile, /UserCard\.svelte$/)
    }, [{ name: "compile-svelte-fixture", transform(source, id) {
      if (id.endsWith(".svelte")) return compile(source, { filename: id, dev: true, generate: "client" }).js.code
    } }])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("Angular: the public debugging API identifies a real bootstrapped standalone component", { timeout: 60_000 }, async () => {
  const root = tempFixture("uix-real-angular-")
  const scenario = { id: "s", title: "S", group: "G", actions: [] }
  try {
    fs.writeFileSync(path.join(root, "index.html"), '<user-card></user-card><script type="module" src="/main.js"></script>')
    fs.writeFileSync(path.join(root, "main.js"), `import "@angular/compiler";
      import { Component } from "@angular/core"; import { bootstrapApplication } from "@angular/platform-browser";
      class UserCard {};
      Component({ selector: "user-card", standalone: true, template: "<div>Real Angular card</div>" })(UserCard);
      bootstrapApplication(UserCard).catch(console.error);`)
    await withServer(root, [scenario], async (base) => {
      const [capture] = await captureDesigns({ baseUrl: base, startPath: "/", scenario, widths: [800] })
      const component = find(capture.root, (node) => node.component?.framework === "angular")
      assert.ok(component, "real bootstrapped Angular component detected")
      assert.equal(component.component.name, "UserCard")
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("React: a fiber's displayName and dev-mode source are recovered directly from the running app", { timeout: 60_000 }, async () => {
  const root = tempFixture("uix-detect-react-")
  fs.mkdirSync(path.join(root, "src"))
  fs.writeFileSync(
    path.join(root, "src", "main.js"),
    `import { createElement } from "react"
    import { createRoot } from "react-dom/client"
    function UserCard() { return createElement("div", { className: "card" }, createElement("span", null, "Alex Morgan")) }
    createRoot(document.getElementById("root")).render(createElement(UserCard))`,
  )
  fs.writeFileSync(
    path.join(root, "index.html"),
    `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>`,
  )
  const scenario = { id: "s", title: "S", group: "G", actions: [] }
  await withServer(root, [scenario], async (base) => {
    const [capture] = await captureDesigns({ baseUrl: base, startPath: "/", scenario, widths: [800] })
    const tagged = find(capture.root, (node) => node.component?.name === "UserCard")
    assert.ok(tagged, "the component boundary was found")
    assert.equal(tagged.component.framework, "react")
    // Only the component's own root gets tagged - not every descendant already covered by it.
    const span = find(tagged, (node) => node.text?.content === "Alex Morgan")
    assert.notEqual(span, tagged)
    assert.equal(span.component, undefined, "a descendant already inside the tagged root is not re-tagged")
  })
  fs.rmSync(root, { recursive: true, force: true })
})

test("Vue 3: the component's registered name is recovered from the owning instance", { timeout: 60_000 }, async () => {
  const root = tempFixture("uix-detect-vue-")
  fs.mkdirSync(path.join(root, "src"))
  fs.writeFileSync(
    path.join(root, "src", "main.js"),
    `import { createApp, h } from "vue"
    const UserCard = { name: "UserCard", render() { return h("div", { class: "card" }, [h("span", null, "Alex Morgan")]) } }
    createApp(UserCard).mount("#root")`,
  )
  fs.writeFileSync(
    path.join(root, "index.html"),
    `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.js"></script></body></html>`,
  )
  const scenario = { id: "s", title: "S", group: "G", actions: [] }
  await withServer(root, [scenario], async (base) => {
    const [capture] = await captureDesigns({ baseUrl: base, startPath: "/", scenario, widths: [800] })
    const tagged = find(capture.root, (node) => node.component?.name === "UserCard")
    assert.ok(tagged, "the component boundary was found")
    assert.equal(tagged.component.framework, "vue")
  })
  fs.rmSync(root, { recursive: true, force: true })
})

test("Web Components: the custom element's own tag name resolves via the standard registry, no internals needed", { timeout: 60_000 }, async () => {
  const root = tempFixture("uix-detect-wc-")
  fs.writeFileSync(
    path.join(root, "index.html"),
    `<!doctype html><html><body>
      <user-card></user-card>
      <script>
        class UserCard extends HTMLElement {
          connectedCallback() { this.innerHTML = "<span>Alex Morgan</span>" }
        }
        customElements.define("user-card", UserCard)
      </script>
    </body></html>`,
  )
  const scenario = { id: "s", title: "S", group: "G", actions: [] }
  await withServer(root, [scenario], async (base) => {
    const [capture] = await captureDesigns({ baseUrl: base, startPath: "/", scenario, widths: [800] })
    const tagged = find(capture.root, (node) => node.tag === "user-card")
    assert.ok(tagged?.component, "the custom element was tagged as a component")
    assert.equal(tagged.component.name, "UserCard")
    assert.equal(tagged.component.framework, "web-component")
  })
  fs.rmSync(root, { recursive: true, force: true })
})

// Angular and Svelte each expose a documented-shape dev-mode hook (the Angular DevTools debugging
// helper, and Svelte's compiler-attached __svelte_meta), and Astro exposes a documented scoped-style
// attribute. Running a real Angular/Svelte/Astro build is out of scope here - this verifies the runtime
// reads each hook correctly when present, using the exact shape each framework's own docs/source describe.
test("Angular, Svelte and Astro: each documented hook shape is read correctly when present", { timeout: 60_000 }, async () => {
  const root = tempFixture("uix-detect-synth-")
  fs.writeFileSync(
    path.join(root, "index.html"),
    `<!doctype html><html><body>
      <div id="ng-host">Angular host</div>
      <div id="svelte-host">Svelte host</div>
      <div id="astro-host" data-astro-cid-abc123>Astro host</div>
      <script>
        class RoleTable {}
        window.ng = { getComponent: (el) => (el.id === "ng-host" ? new RoleTable() : undefined) }
        document.getElementById("svelte-host").__svelte_meta = { loc: { file: "src/RoleBadge.svelte", line: 3 } }
      </script>
    </body></html>`,
  )
  const scenario = { id: "s", title: "S", group: "G", actions: [] }
  await withServer(root, [scenario], async (base) => {
    const [capture] = await captureDesigns({ baseUrl: base, startPath: "/", scenario, widths: [800] })
    const ng = find(capture.root, (node) => node.component?.framework === "angular")
    assert.equal(ng?.component.name, "RoleTable")
    const svelte = find(capture.root, (node) => node.component?.framework === "svelte")
    assert.equal(svelte?.component.name, "RoleBadge.svelte")
    assert.equal(svelte?.component.sourceFile, "src/RoleBadge.svelte")
    assert.equal(svelte?.component.sourceLine, 3)
    const astro = find(capture.root, (node) => node.component?.framework === "astro")
    assert.equal(astro?.component.name, "abc123")
  })
  fs.rmSync(root, { recursive: true, force: true })
})
