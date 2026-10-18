import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"
import test from "node:test"
import { build } from "esbuild"
import { buildPlan } from "../dist/node/index.js"
const hashModule={exports:{}}
vm.runInNewContext((await build({entryPoints:['src/shared/hash.ts'],bundle:true,write:false,format:'cjs'})).outputFiles[0].text,{module:hashModule})
const {hashString}=hashModule.exports

const bundle = (await build({ entryPoints: ["figma-plugin/src/code.ts"], bundle: true, write: false, format: "iife", target: "es2017" })).outputFiles[0].text
function harness(options = {}) {
  let serial = 0
  const messages = [], storage = {}, paints = [], texts = [], imports = []
  function node(type) {
    const data = {}
    const n = { id: String(++serial), type, name: type, x: 0, y: 0, width: 100, height: 100,
      fills: [], strokes: [], effects: [], children: [], opacity: 1, visible: true,
      getPluginData: (key) => data[key] ?? "", setPluginData: (key, value) => { data[key] = value },
      resize(w, h) { this.width = w; this.height = h },
      resizeWithoutConstraints(w, h) { this.width = w; this.height = h },
      async loadAsync() {},
      rescale(scale) { this.width *= scale; this.height *= scale; for (const child of this.children) { child.x *= scale; child.y *= scale; child.rescale(scale) } },
      appendChild(child) { child.parent?.children.splice(child.parent.children.indexOf(child), 1); this.children.push(child); child.parent = this },
      remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1) },
      findAll(predicate) { return this.children.flatMap((child) => [...(predicate(child) ? [child] : []), ...child.findAll(predicate)]) },
      findOne(predicate) { return this.findAll(predicate)[0] },
      async setFillStyleIdAsync(id) { this.fillStyleId = id; this.fills = paints.find((paint) => paint.id === id)?.paints ?? [] },
      async setTextStyleIdAsync(id) { this.textStyleId = id; Object.assign(this, texts.find((text) => text.id === id)) },
      getRangeAllFontNames() { return [{ family: "Inter", style: "Regular" }] },
      createInstance() {
        const clone = (source) => { const result = node(source.type === "COMPONENT" ? "INSTANCE" : source.type); for (const key of ["name", "x", "y", "width", "height", "characters", "fontName", "fontSize"]) result[key] = source[key]; for (const child of source.children) result.appendChild(clone(child)); return result }
        const instance = clone(this); instance.mainComponent = this; return instance
      },
    }
    return n
  }
  const root = node("DOCUMENT"), page = node("PAGE"); page.selection = []; root.appendChild(page)
  const api = { root, currentPage: page, ui: { onmessage: null, postMessage: (message) => {
    messages.push(message)
    if (message.type === 'host-yield') queueMicrotask(() => api.ui.onmessage({type:'host-yield',id:message.id}))
  } },
    viewport: { scrollAndZoomIntoView() {} },
    notify() {}, showUI() {}, on() {}, loadAllPagesAsync: async () => {}, loadFontAsync: async () => {},
    listAvailableFontsAsync: async () => [{ fontName: { family: "Inter", style: "Regular" } }],
    getLocalPaintStylesAsync: async () => paints, getLocalTextStylesAsync: async () => texts,
    createPaintStyle() { const style = { id: String(++serial), type: "PAINT", paints: [] }; paints.push(style); return style },
    createTextStyle() { const style = { id: String(++serial), type: "TEXT" }; texts.push(style); return style },
    createPage() { const page = node("PAGE"); root.appendChild(page); return page },
    createSection: () => node("SECTION"),
    createFrame: () => node("FRAME"), createComponent: () => node("COMPONENT"), createText: () => node("TEXT"),
    createNodeFromSvg: () => { const frame = node("FRAME"), vector = node("VECTOR"); frame.resize(256,256); vector.resize(256,256); frame.appendChild(vector); return frame },
    combineAsVariants(children, page) { const set = node("COMPONENT_SET"); page.appendChild(set); children.forEach((child) => set.appendChild(child)); return set },
    clientStorage: { getAsync: async (key) => storage[key], setAsync: async (key, value) => { storage[key] = value } },
    importComponentByKeyAsync: async (key) => { imports.push(key); throw new Error("not published") },
    getNodeByIdAsync: async (id) => root.findOne((node) => node.id === id),
  }
  vm.runInNewContext(bundle, { figma: api, __html__: "<html></html>", console, Uint8Array, setTimeout: options.sandboxTimer ?? setTimeout, Date: options.clock ?? Date })
  return { api, page, root, imports, paints, messages, async send(command) {
    const count = messages.length; api.ui.onmessage(command)
    const expected = ['connection-bootstrap','connection-context'].includes(command.type) ? command.type : 'result'
    const result = () => messages.slice(count).findLast(message=>message.type===expected)
    for (let i = 0; i < 200 && !result(); i++) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.ok(result(), "plugin returns a result for success and failure")
    return JSON.parse(JSON.stringify(result()))
  } }
}
const leaf = (content, x = 35) => ({ tag: "span", rect: { x, y: 45, width: 80, height: 20 }, fills: [], children: [],
  text: { content, fontFamily: "Inter", fontWeight: 400, fontSize: 14, lineHeight: "normal", letterSpacing: "normal", color: "rgb(0, 0, 0)", align: "left" } })
const makePlan = (content = "Save") => buildPlan([{ scenarioId: "screen", width: 1440, root: { tag: "body", rect: { x: 0, y: 0, width: 1440, height: 900 }, fills: [], children: [
  { tag: "div", component: { id: "card", name: "Card", framework: "react" }, rect: { x: 20, y: 30, width: 120, height: 60 }, fills: [], children: [leaf(content)] },
] } }], { 1440: "Desktop" })
const command = (plan, extra = {}) => ({ type: "build", plan, placement: { mode: "current-page" }, ...extra })

test('long imports yield through the UI without sandbox timers or waiting behind their own command', async()=>{
 let now=0
 const h=harness({clock:{now:()=>now+=50},sandboxTimer:()=>{throw Error('Sandbox timers unavailable')}})
 const result=await h.send({...command(makePlan()),requestId:'yielding-import'})
 assert.equal(result.error,undefined)
 assert.deepEqual(result.coverage,{missing:[],unexpected:[]})
 assert.ok(h.messages.filter(m=>m.type==='host-yield').length>=2,'recursive drawing resumes after multiple UI round trips')
 assert.equal((await h.send({...command(makePlan()),requestId:'after-yield'})).error,undefined)
})

test('connection bootstrap restores a paired bridge and reports file context without mutating the canvas', async()=>{
 const h=harness(), before=h.page.children.length
 h.api.ui.onmessage({type:'save-connection',connection:{url:'http://localhost:5198',token:'fixture',requestId:'abcdefghijklmnop'}})
 const restored=await h.send({type:'connection-bootstrap'})
 assert.equal(restored.connection.requestId,'abcdefghijklmnop')
 assert.deepEqual(restored.context,{documentName:h.root.name,pageId:h.page.id,pageName:h.page.name})
 h.api.ui.onmessage({type:'forget-connection'})
 assert.equal((await h.send({type:'connection-bootstrap'})).connection,undefined)
 assert.equal(h.page.children.length,before)
})

test('the sandbox returns a cached result for a repeated command ID instead of executing it again', async()=>{
 const h=harness()
 const first=await h.send({...command(makePlan('Original')),requestId:'same-command'})
 const duplicate=await h.send({...command(makePlan('Changed')),requestId:'same-command'})
 assert.deepEqual(duplicate,first)
 assert.ok(h.page.findAll(n=>n.type==='TEXT').some(n=>n.characters==='Original'))
 assert.ok(!h.page.findAll(n=>n.type==='TEXT').some(n=>n.characters==='Changed'))
})

test('a multi-command export reads pages and available fonts once, then refreshes them for the next run',async()=>{
 const h=harness();let pages=0,fonts=0
 h.api.loadAllPagesAsync=async()=>{pages++}
 h.api.listAvailableFontsAsync=async()=>{fonts++;return [{fontName:{family:'Inter',style:'Regular'}}]}
 for(const runId of ['first','second']){
  assert.equal((await h.send({type:'begin-export',runId})).error,undefined)
  assert.equal((await h.send(command(makePlan('Save'),{runId}))).error,undefined)
  assert.equal((await h.send(command(makePlan('Next'),{runId}))).error,undefined)
  await h.send({type:'verify',runId,expected:[{scenarioId:'screen',width:1440}],placement:{mode:'current-page'}})
  await h.send({type:'end-export',runId})
 }
 assert.equal(pages,2);assert.equal(fonts,2)
})

test('export preparation loads only its destination and component library, without visiting unrelated pages',async()=>{
 const h=harness()
 await h.send(command(makePlan()))
 const library=h.root.children.find(p=>p.name.includes('UI Explorer Components'))
 const unrelated=h.api.createPage();unrelated.name='Unrelated'
 unrelated.loadAsync=async()=>{throw Error('Unrelated page must not load')}
 let all=0;const loaded=[]
 h.api.loadAllPagesAsync=async()=>{all++;throw Error('Whole-file load must not run')}
 for(const p of [h.page,library])p.loadAsync=async()=>{loaded.push(p.id)}
 assert.equal((await h.send({type:'begin-export',runId:'scoped',placement:{mode:'current-page'}})).error,undefined)
 assert.deepEqual(new Set(loaded),new Set([h.page.id,library.id]))
 assert.equal((await h.send(command(makePlan(),{runId:'scoped'}))).error,undefined)
 await h.send({type:'verify',runId:'scoped',expected:[{scenarioId:'screen',width:1440}],placement:{mode:'current-page'}})
 assert.equal(all,0)
 await h.send({type:'end-export',runId:'scoped'})
})

test('component edit baselines cover the complete selected scope before writes and skip unrelated masters',async()=>{
 const h=harness(),plan=makePlan()
 await h.send(command(plan))
 const library=h.root.children.find(p=>p.name.includes('UI Explorer Components'))
 const unrelated=h.api.createComponent();library.appendChild(unrelated);unrelated.name='Unrelated'
 unrelated.setPluginData('uix:componentId','unrelated');unrelated.setPluginData('uix:appliedHash','old')
 Object.defineProperty(unrelated,'fills',{get(){throw Error('Unrelated master must not be fingerprinted')}})
 const otherVariant=h.api.createComponent();library.appendChild(otherVariant);otherVariant.name='Breakpoint=Tablet'
 otherVariant.setPluginData('uix:componentId',plan.components[0].componentId);otherVariant.setPluginData('uix:variant','Breakpoint=Tablet');otherVariant.setPluginData('uix:appliedHash','old')
 const selectedMaster=library.findOne(n=>n.type==='COMPONENT'&&n.getPluginData('uix:componentId')===plan.components[0].componentId&&n!==otherVariant)
 selectedMaster.name=selectedMaster.getPluginData('uix:variant')
 const holder=h.api.combineAsVariants([selectedMaster,otherVariant],library);holder.name=plan.components[0].name;holder.setPluginData('uix:componentId',plan.components[0].componentId)
 Object.defineProperty(otherVariant,'fills',{get(){throw Error('Unrequested variant must not be fingerprinted')}})
 const begin=await h.send({type:'begin-export',runId:'scoped-components',placement:{mode:'current-page'},deferComponentBaseline:true})
 assert.equal(begin.error,undefined)
 const missing=await h.send(command(plan,{runId:'scoped-components'}))
 assert.match(missing.error,/complete component scope/)
 Object.defineProperty(selectedMaster,'fills',{get(){throw Error('An unchanged source master must not be fingerprinted')}})
 const built=await h.send(command(plan,{runId:'scoped-components',componentScope:plan.components.map(c=>({componentId:c.componentId,variants:c.variants.map(v=>({name:v.variantName,contentHash:hashString(JSON.stringify(v.node))}))}))}))
 assert.equal(built.error,undefined)
 await h.send({type:'end-export',runId:'scoped-components'})
})

test('deferred component protection still preserves manual edits when the selected source changes',async()=>{
 const h=harness();await h.send(command(makePlan('Original')))
 const master=h.root.findOne(n=>n.type==='COMPONENT'&&n.getPluginData('uix:componentId')==='card')
 master.findOne(n=>n.type==='TEXT').characters='Manual design edit'
 const plan=makePlan('Changed source'),runId='protected-deferred'
 await h.send({type:'begin-export',runId,placement:{mode:'current-page'},deferComponentBaseline:true})
 const result=await h.send(command(plan,{runId,componentScope:plan.components.map(c=>({componentId:c.componentId,variants:c.variants.map(v=>({name:v.variantName,contentHash:hashString(JSON.stringify(v.node))}))}))}))
 assert.equal(result.error,undefined);assert.ok(result.conflicts.some(message=>message.includes('Component Card')))
 assert.equal(master.findOne(n=>n.type==='TEXT').characters,'Manual design edit')
 await h.send({type:'end-export',runId})
})

test('a failed font load identifies its Figma operation and can recover without reopening the plugin',async()=>{
 const h=harness();let attempts=0
 h.api.loadFontAsync=async()=>{if(++attempts===1)throw Error('Font service temporarily unavailable')}
 const first=await h.send(command(makePlan()))
 assert.match(first.error,/Loading font Inter Regular:.*Font service temporarily unavailable/)
 const second=await h.send(command(makePlan()))
 assert.equal(second.error,undefined);assert.ok(attempts>=2)
})

test("regular-layer imports skip masters and libraries, preserve editable text, and rebuild when output mode changes", async () => {
  const h = harness(), plan = {...makePlan(),createComponents:false}
  const plain = await h.send(command(plan,{libraries:{components:{card:{key:"published"}}}}))
  assert.equal(plain.error,undefined)
  assert.deepEqual(h.imports,[])
  assert.equal(h.root.findAll(node=>["COMPONENT","COMPONENT_SET","INSTANCE"].includes(node.type)).length,0)
  assert.equal(h.root.children.length,1,"no Components page is created")
  const frame = h.page.findOne(node=>node.getPluginData("uix:scenarioId")==="screen")
  const id=frame.id
  assert.equal(frame.children[0].name,"Card")
  assert.equal(frame.children[0].children[0].type,"TEXT")
  assert.equal(frame.children[0].children[0].characters,"Save")
  assert.equal(frame.children[0].children[0].x,15)
  assert.equal((await h.send(command(plan))).report.length,0,"repeated plain imports are idempotent")
  assert.deepEqual((await h.send(command(makePlan()))).conflicts,[])
  assert.equal(frame.children[0].type,"INSTANCE")
  const masters = h.root.findAll(node=>node.type==="COMPONENT").map(node=>node.id)
  assert.deepEqual((await h.send(command(plan))).conflicts,[])
  assert.equal(frame.id,id)
  assert.equal(frame.children[0].type,"FRAME")
  assert.equal(frame.findAll(node=>node.type==="INSTANCE").length,0,"existing masters are not reused in layer mode")
  assert.deepEqual(h.root.findAll(node=>node.type==="COMPONENT").map(node=>node.id),masters,"existing masters remain untouched")
})

test("plugin creates real single-variant instances, subtracts parent offsets, skips repeats, and updates without changing frame identity or position", async () => {
  const h = harness(), first = await h.send(command(makePlan()))
  assert.equal(first.error, undefined)
  assert.deepEqual(first.coverage, { missing: [], unexpected: [] })
  const frame = h.page.findOne((node) => node.getPluginData("uix:scenarioId") === "screen")
  assert.equal(frame.children[0].type, "INSTANCE")
  assert.equal(frame.children[0].children[0].x, 15)
  assert.equal(frame.children[0].children[0].y, 15)
  const originalId = frame.id; frame.x = 400
  assert.equal((await h.send(command(makePlan()))).report.length, 0)
  const updated = await h.send(command(makePlan("Cancel")))
  assert.deepEqual(updated.conflicts, [])
  const after = h.page.findOne((node) => node.getPluginData("uix:scenarioId") === "screen")
  assert.equal(after.id, originalId); assert.equal(after.x, 400)
})

test("plugin protects hand-edited appearance and reports failed library imports", async () => {
  const h = harness(); await h.send(command(makePlan()))
  const frame = h.page.findOne((node) => node.getPluginData("uix:scenarioId") === "screen")
  frame.fills = [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }]
  const result = await h.send(command(makePlan("New"), { libraries: { components: { card: { key: "published" } } } }))
  assert.equal(result.conflicts.length, 1); assert.match(result.warnings[0], /unavailable/)
  assert.equal(frame.fills[0].color.r, 1); assert.deepEqual(h.imports, ["published"])
})

test("standalone masters retain source names after updates and legacy variant labels can be repaired in place", async () => {
  const h = harness(); await h.send(command(makePlan()))
  const master = h.root.findOne(node=>node.type === "COMPONENT" && node.getPluginData("uix:componentId")==="card")
  assert.equal(master.name,"Card")
  await h.send(command(makePlan("Cancel")))
  assert.equal(master.name,"Card","updates must not replace the master name with its breakpoint")
  const frame=h.page.findOne(node=>node.getPluginData("uix:scenarioId")==="screen")
  assert.equal(frame.children[0].name,"Card","instance labels use the source component name")
  const id=master.id,children=master.children.map(node=>node.id)
  master.name="Breakpoint=Desktop"
  const repaired=await h.send({type:"repair-component-names",names:{card:"Card"}})
  assert.equal(master.name,"Card"); assert.equal(master.id,id)
  assert.deepEqual(master.children.map(node=>node.id),children)
  assert.equal(repaired.componentNames.length,1)
  master.name="My custom card"
  assert.equal((await h.send({type:"repair-component-names",names:{card:"Card"}})).componentNames.length,0)
  assert.equal(master.name,"My custom card","human names are preserved")
})

test("plugin requires a destination and returns errors to the panel, then recovers for the next request", async () => {
  const h = harness()
  assert.match((await h.send({ type: "build", plan: makePlan() })).error, /destination/)
  const result = await h.send(command(makePlan(), { placement: { mode: "page", name: "Imported" } }))
  assert.equal(result.error, undefined)
  assert.ok(h.root.children.find((page) => page.name === "Imported").findOne((node) => node.getPluginData("uix:scenarioId") === "screen"))
})

test("unreadable existing instance properties do not abort imports or overwrite affected frames", async () => {
  const h = harness(); await h.send(command(makePlan()))
  const frame = h.page.findOne((node) => node.getPluginData("uix:scenarioId") === "screen")
  Object.defineProperty(frame.children[0], "componentProperties", { get() { throw new Error("Component set has existing errors") } })
  const result = await h.send(command(makePlan("Changed")))
  assert.equal(result.error, undefined)
  assert.match(result.warnings.join(" "), /properties could not be inspected/)
  assert.match(result.conflicts.join(" "), /screen/)
  assert.equal(frame.children[0].children[0].characters, "Save")
})

test("promoting a single master and adding appearance states keeps consistent Figma variant properties", async () => {
  const h = harness(); await h.send(command(makePlan()))
  const expanded = makePlan()
  const original = expanded.components[0].variants[0]
  expanded.components[0].variants.push({ ...structuredClone(original), variantName: "Breakpoint=Mobile, State=Active" })
  const result = await h.send(command(expanded))
  assert.equal(result.error, undefined)
  const set = h.root.findOne((node) => node.type === "COMPONENT_SET")
  assert.deepEqual(set.children.map((node) => node.name), ["Breakpoint=Desktop, State=Default", "Breakpoint=Mobile, State=Active"])
  assert.equal(set.children[0].getPluginData("uix:variant"), "Breakpoint=Desktop")
  await h.send({type:"repair-component-names",names:{card:"Card"}})
  assert.equal(set.name,"Card")
  assert.deepEqual(set.children.map((node) => node.name), ["Breakpoint=Desktop, State=Default", "Breakpoint=Mobile, State=Active"],"variant labels remain inside their named set")
  assert.equal((await h.send(command(expanded))).report.length, 0)
})

test("plugin UI is self-contained instead of depending on a relative external script", () => {
  const html = fs.readFileSync("figma-plugin/ui.html", "utf8")
  assert.doesNotMatch(html, /<script[^>]+src=/)
  assert.match(html, /addEventListener\("message"/)
})

test("rendered layers retain clipping, control text offsets and vector scale", async () => {
  const h = harness(), text = leaf("Padded")
  text.rect = { x:20,y:30,width:200,height:50 }; text.textRect = { x:37,y:44,width:166,height:21 }
  text.fills = [{ type:"solid", color:"rgb(255, 255, 255)" }]
  const vector = { tag:"svg",svg:'<svg/>',rect:{x:250,y:40,width:16,height:16},fills:[],children:[] }
  const plan = { components:[],frames:[{ scenarioId:"layout",width:1440,node:{tag:"viewport",rect:{x:0,y:0,width:1440,height:900},fills:[],clipsContent:true,children:[text,vector]} }] }
  const result = await h.send(command(plan)); assert.equal(result.error,undefined)
  const frame = h.page.findOne(node=>node.getPluginData("uix:scenarioId")==="layout")
  assert.equal(frame.clipsContent,true)
  assert.equal(frame.children[0].children[0].x,17); assert.equal(frame.children[0].children[0].y,14)
  assert.equal(frame.children[1].children[0].width,16,"SVG paths scale with their imported viewport")
})

test("bulk sections reuse identity, arrange variable-size frames, protect moved content and pin the run page", async () => {
  const h = harness(), placement = { mode:'current-page',container:'Hiring review' }, runId='bulk'
  await h.send({type:'begin-export',runId})
  const other = h.api.createPage(); other.name='Other'; h.api.currentPage=other
  const frames = [
    {scenarioId:'a',width:400,node:{tag:'viewport',rect:{x:0,y:0,width:400,height:300},fills:[],children:[]}},
    {scenarioId:'b',width:200,node:{tag:'viewport',rect:{x:0,y:0,width:200,height:500},fills:[],children:[]}},
    {scenarioId:'c',width:300,node:{tag:'viewport',rect:{x:0,y:0,width:300,height:100},fills:[],children:[]}}
  ]
  for (const frame of frames) assert.equal((await h.send({type:'build',plan:{components:[],frames:[frame]},placement,runId})).error,undefined)
  const section=h.page.children.find(n=>n.type==='SECTION'), expected=frames.map(({scenarioId,width})=>({scenarioId,width}))
  assert.ok(section); assert.equal(other.children.length,0)
  const ids=section.children.map(n=>n.id)
  const arrange={type:'arrange',expected,placement,runId,layout:{mode:'grid',columns:2,gap:20}}
  assert.equal((await h.send(arrange)).error,undefined)
  assert.deepEqual(section.children.map(n=>[n.x,n.y]),[[40,40],[460,40],[40,560]])
  assert.equal(section.width,700); assert.equal(section.height,700)
  for(const frame of frames) await h.send({type:'build',plan:{components:[],frames:[frame]},placement,runId})
  assert.deepEqual(section.children.map(n=>n.id),ids); assert.equal(h.page.children.filter(n=>n.type==='SECTION').length,1)
  assert.equal((await h.send({...arrange,layout:{mode:'horizontal',gap:20}})).conflicts.length,0)
  assert.deepEqual(section.children.map(n=>[n.x,n.y]),[[40,40],[460,40],[680,40]])
  section.children[1].x=999
  const result=await h.send(arrange)
  assert.match(result.conflicts.join(' '),/moved position/); assert.equal(section.children[1].x,999)
  assert.deepEqual((await h.send({type:'verify',expected,placement,runId})).coverage,{missing:[],unexpected:[]})
  await h.send({type:'end-export',runId})
})
