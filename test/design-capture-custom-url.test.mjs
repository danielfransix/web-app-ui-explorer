import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createServer } from "vite"
import { captureDesigns } from "../dist/node/index.js"
import uiExplorer from "../dist/node/vite.js"
import { createServer as createHttpServer } from "node:http"

test('capture waits for a visible loading fallback even when replay and network activity have settled', {timeout:15000},async()=>{
 const server=createHttpServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><body>
 <div id="screen" data-uix-loading aria-busy="true">Loading role…</div>
 <div data-uix-loading hidden>Hidden loading indicator</div>
 <script>
 window.__uix={settle:async()=>{},captureDesign:()=>({tag:'body',rect:{x:0,y:0,width:1024,height:900},fills:[],children:[],text:{content:document.querySelector('#screen').textContent}})};
 setTimeout(()=>{const screen=document.querySelector('#screen');screen.textContent='Software Designer hiring pipeline';screen.removeAttribute('data-uix-loading');screen.setAttribute('aria-busy','false')},3000);
 </script>`)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{
  const [capture]=await captureDesigns({baseUrl:`http://127.0.0.1:${server.address().port}`,startPath:'/',scenario:{id:'pipeline',title:'Pipeline',group:'Roles',url:'/'},widths:[1024]})
  assert.equal(capture.root.text.content,'Software Designer hiring pipeline')
 }finally{await new Promise(resolve=>server.close(resolve))}
})

// Some hosts route previews through their own app-level URL (e.g. `/?scenario=<id>`) instead of the
// explorer's `?__uix=<id>` replay recipe - the pattern this project's own real target app uses for every
// curated scenario. That page never carries the `__uix` query param, so the injected runtime never
// becomes "active" on its own and `window.__uix` is never installed - this reproduces that exact failure
// (`Cannot read properties of undefined (reading 'settle')`) and confirms the fix.

test("captureDesigns works for a scenario with its own url, which never sets __uix and so never auto-activates the runtime", { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-custom-url-"))
  fs.writeFileSync(
    path.join(root, "index.html"),
    `<!doctype html><html><body>
      <div id="app"></div>
      <script>
        const params = new URLSearchParams(location.search)
        document.getElementById("app").innerHTML =
          params.get("scenario") === "role-settings" ? "<h1>Role settings</h1>" : "<h1>Home</h1>"
      </script>
    </body></html>`,
  )
  const scenario = {
    id: "role-settings",
    title: "Role settings",
    group: "Roles",
    source: "src/screens/RoleSettings.tsx",
    url: "/?scenario=role-settings&preview-embed=1",
  }
  const server = await createServer({
    root, configFile: false, logLevel: "error", server: { host: "127.0.0.1", port: 0 },
    plugins: [uiExplorer({ mode: "manual", autoCapture: false, scenarios: [scenario] })],
  })
  try {
    await server.listen()
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    const [capture] = await captureDesigns({ baseUrl: base, startPath: "/", scenario, widths: [1024] })
    assert.match(JSON.stringify(capture.root), /Role settings/)
  } finally {
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
