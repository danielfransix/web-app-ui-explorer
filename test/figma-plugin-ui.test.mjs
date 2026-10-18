import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import { chromium } from "playwright"

test('the UI acknowledges sandbox yields independently of connection and import state', {timeout:15000},async()=>{
 const browser=await chromium.launch()
 try{
  const page=await browser.newPage()
  await page.setContent('<iframe></iframe><script>window.yieldReplies=[];window.addEventListener("message",e=>{if(e.data.pluginMessage?.type==="host-yield")window.yieldReplies.push(e.data.pluginMessage.id)})</script>')
  await page.locator('iframe').evaluate((iframe,html)=>{iframe.srcdoc=html},fs.readFileSync('figma-plugin/ui.html','utf8'))
  const panel=page.frameLocator('iframe')
  await panel.locator('#status').waitFor({state:'attached'})
  await page.locator('iframe').evaluate(iframe=>iframe.contentWindow.postMessage({pluginMessage:{type:'host-yield',id:41}},'*'))
  await page.waitForFunction(()=>window.yieldReplies.includes(41))
  assert.deepEqual(await page.evaluate(()=>window.yieldReplies),[41])
 }finally{await browser.close()}
})

test('restoring retries a temporary ownership conflict and an expired selection does not break the pairing', {timeout:15000},async()=>{
 const browser=await chromium.launch()
 try{
  const page=await browser.newPage({viewport:{width:540,height:820}})
  let connects=0,exports=0
  await page.route('http://localhost:5198/**',async route=>{
   const p=new URL(route.request().url()).pathname
   if(p==='/imports')exports++
   const conflict=p==='/connect'&&++connects===1
   const expired=p.startsWith('/handoffs/')
   await route.fulfill({status:conflict?409:expired?410:200,contentType:'application/json',body:JSON.stringify(conflict?{error:'Another Figma plugin is connected. This plugin will retry when it closes.'}:expired?{error:'This import code has expired.'}:p==='/poll'?[]:p==='/agents'?{clients:[]}:p==='/imports/current'?null:{connected:true})})
  })
  await page.setContent(fs.readFileSync('figma-plugin/ui.html','utf8'))
  await page.evaluate(()=>window.postMessage({pluginMessage:{type:'connection-bootstrap',connection:{url:'http://localhost:5198',token:'abcdefghijklmnopqrstuv',requestId:'abcdefghijklmnop'},context:{documentName:'Utilities',pageId:'1:2',pageName:'App'}}},'*'))
  await page.locator('#status').filter({hasText:'Reconnected to your local project. The previous selection expired.'}).waitFor()
  assert.equal(connects,2)
  assert.equal(await page.locator('#connection-state-label').textContent(),'Connected')
  assert.equal(await page.locator('#handoff-feedback').isVisible(),false)
  assert.equal(await page.getByLabel('Import code',{exact:true}).inputValue(),'')
  assert.equal(exports,0,'restoring ownership never starts another import')
 }finally{await browser.close()}
})

test('a saved pairing reconnects and restores its selection without a paste, with visible file identity', {timeout:30000}, async()=>{
 const browser=await chromium.launch()
 try{
  const page=await browser.newPage({viewport:{width:540,height:820}})
  const errors=[],requests=[];page.on('pageerror',error=>errors.push(error.message))
  await page.route('http://localhost:5198/**',async route=>{
   const request=route.request(),pathname=new URL(request.url()).pathname
   requests.push({path:pathname,body:request.postDataJSON()})
   const body=pathname==='/poll'?[]:pathname==='/agents'?{clients:[]}:pathname==='/imports/current'?null:pathname.startsWith('/handoffs/')?{id:'abcdefghijklmnop',project:'Saved project',screens:[{id:'a',title:'Home'}],screenCount:1,widths:[1440],frameCount:1,expiresAt:Date.now()+3600000}:{connected:true}
   await route.fulfill({contentType:'application/json',body:JSON.stringify(body)})
  })
  await page.setContent(fs.readFileSync('figma-plugin/ui.html','utf8'))
  await page.evaluate(()=>window.postMessage({pluginMessage:{type:'connection-bootstrap',connection:{url:'http://localhost:5198',token:'abcdefghijklmnopqrstuv',requestId:'abcdefghijklmnop'},context:{documentName:'Utilities',pageId:'12:34',pageName:'Hiring'}}},'*'))
  await page.locator('#request-project').filter({hasText:'Saved project'}).waitFor()
  assert.equal(await page.locator('#figma-destination').textContent(),'Figma file: Utilities · Page: Hiring')
  assert.ok(requests.some(r=>r.path==='/handoff/loaded'&&r.body.id==='abcdefghijklmnop'))
  assert.ok(requests.some(r=>r.path==='/connection/context'&&r.body.context.pageId==='12:34'))
  assert.ok(!requests.some(r=>r.path==='/imports'),'reconnecting never starts an import')
  await page.screenshot({path:'.ui-explorer/plugin-paired-restore.png'})
  assert.deepEqual(errors,[])
 }finally{await browser.close()}
})

test('disconnect wins over a delayed automatic connection and does not start a retry', {timeout:15000}, async()=>{
 const browser=await chromium.launch()
 try{
  const page=await browser.newPage({viewport:{width:540,height:820}})
  let release,connects=0
  const held=new Promise(resolve=>{release=resolve})
  await page.route('http://localhost:5198/**',async route=>{
   const path=new URL(route.request().url()).pathname
   if(path==='/connect'){connects++;await held}
   await route.fulfill({contentType:'application/json',body:JSON.stringify(path==='/poll'?[]:{connected:true})})
  })
  await page.setContent(fs.readFileSync('figma-plugin/ui.html','utf8'))
  const pending=page.waitForRequest(r=>r.url().endsWith('/connect'))
  await page.evaluate(()=>window.postMessage({pluginMessage:{type:'connection-bootstrap',connection:{url:'http://localhost:5198',token:'abcdefghijklmnopqrstuv'},context:{documentName:'Utilities',pageId:'12:34',pageName:'Hiring'}}},'*'))
  await pending
  await page.locator('#bridge-controls > summary').click()
  await page.getByRole('button',{name:'Connect bridge',exact:true}).click()
  await page.locator('#bridge-status').filter({hasText:'Disconnected'}).waitFor()
  release()
  await page.locator('#mcp-status').waitFor({state:'hidden'})
  await page.waitForTimeout(2800)
  assert.equal(connects,1,'explicit disconnection cancels automatic restore')
  assert.equal(await page.locator('#mcp-status').isVisible(),false)
 }finally{await browser.close()}
})

async function chooseDropdown(panel, id, value) {
  const name = await panel.locator('#' + id).evaluate((select, value) => Array.from(select.options).find(option => option.value === value)?.text, value)
  assert.ok(name, `Missing ${id} option ${value}`)
  await panel.locator('#' + id + '-trigger').click()
  await panel.getByRole('option', { name, exact: true }).click()
}

test('all plugin panels use stack spacing, consistent disclosure hover and bounded controls', {timeout:60000}, async()=>{
 const browser=await chromium.launch()
 try{for(const colorScheme of ['light','dark'])for(const width of [540,320]){
  const page=await browser.newPage({viewport:{width,height:820},colorScheme,reducedMotion:'reduce'})
  page.setDefaultTimeout(5000)
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.route('http://localhost:5198/**',async route=>{
   const pathname=new URL(route.request().url()).pathname
   const body=pathname==='/agents'?{clients:[]}:pathname==='/poll'?[]:pathname==='/imports/current'?null:pathname.startsWith('/handoffs/')?{id:'abcdefghijklmnop',project:'Spacing review',screenCount:2,widths:[1440,390],frameCount:4,screens:[{id:'role',title:'Role'},{id:'menu',title:'Menu'}],expiresAt:Date.now()+3600000}:{connected:true}
   await route.fulfill({contentType:'application/json',body:JSON.stringify(body)})
  })
  await page.setContent(fs.readFileSync('figma-plugin/ui.html','utf8'))
  const hierarchy=await page.evaluate(()=>{
   const size=selector=>parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)
   return {title:size('h1'),section:size('#handoff-source h2'),label:size('label[for="import-code"]'),body:size('#load-import'),help:size('#handoff-source .hint')}
  })
  assert.ok(hierarchy.title>hierarchy.section&&hierarchy.section>hierarchy.body&&hierarchy.body>hierarchy.label&&hierarchy.section>hierarchy.help,'plugin panels have distinct title, section, control and supporting-text roles')
  const disclosure=page.locator('#bridge-controls > summary')
  const measure=locator=>locator.evaluate(node=>{const s=getComputedStyle(node),r=node.getBoundingClientRect();return {width:r.width,height:r.height,padding:s.padding,borderRadius:s.borderRadius}})
  const disconnected=await measure(disclosure)
  await page.getByLabel('Import code',{exact:true}).fill('UIX1:5198:abcdefghijklmnopqrstuvwx:abcdefghijklmnop')
  await page.getByRole('button',{name:'Load import',exact:true}).click()
  await page.getByText('Spacing review',{exact:true}).waitFor()
  assert.deepEqual(await measure(disclosure),disconnected,'connecting preserves the collapsed disclosure padding and hit area')
  await page.screenshot({path:`.ui-explorer/plugin-spacing-ready-${colorScheme}-${width}.png`})
  await page.locator('main details').evaluateAll(nodes=>nodes.forEach(node=>node.open=true))
  await chooseDropdown(page,'placement','section')
  await page.getByLabel('Destination name').fill('Hiring review')
  await page.locator('#libraries').fill('{"components":{}}')
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{pluginMessage:{type:'result',report:['Imported 4 frames','Updated components and styles'],warnings:[],conflicts:[]}}})))
  const audit=async()=>{
   const issues=await page.evaluate(()=>{
    const visible=Array.from(document.querySelectorAll('body *')).filter(node=>node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden')
    return visible.flatMap(node=>{
     const s=getComputedStyle(node),r=node.getBoundingClientRect(),label=node.id||node.className||node.tagName
     const problems=[]
     if([s.marginTop,s.marginRight,s.marginBottom,s.marginLeft].some(value=>parseFloat(value)!==0))problems.push(`${label}: nonzero margin`)
     if(r.left<0||r.right>innerWidth+.5)problems.push(`${label}: horizontal overflow`)
     return problems
    })
   })
   assert.deepEqual(issues,[])
  }
  await audit()
  for(const summary of await page.locator('main details > summary').all()){
   if(!await summary.isVisible())continue
   await summary.scrollIntoViewIfNeeded();await page.mouse.move(0,0)
   const before=await measure(summary)
   await summary.hover()
   assert.deepEqual(await measure(summary),before,'hover never changes disclosure dimensions or padding')
   assert.equal(await summary.evaluate(node=>getComputedStyle(node).backgroundColor),colorScheme==='dark'?'rgb(62, 62, 62)':'rgb(240, 240, 240)')
  }
  await disclosure.scrollIntoViewIfNeeded();await disclosure.hover()
  await page.screenshot({path:`.ui-explorer/plugin-spacing-connection-${colorScheme}-${width}.png`})
  await page.getByRole('button',{name:'Clipboard',exact:true}).click()
  assert.equal(await page.locator('main').evaluate(main=>Array.from(main.children).find(child=>child.getClientRects().length)?.id),'configuration','required destination is first in Clipboard')
  assert.equal(await page.locator('#clipboard-intro').getByRole('button',{name:'Build from clipboard',exact:true}).count(),1)
  assert.equal(await page.locator('footer').getByRole('button',{name:'Build from clipboard',exact:true}).count(),0)
  assert.equal(await page.getByRole('separator',{name:'Alternative import method',exact:true}).isVisible(),true)
  assert.equal(await page.locator('#optional-settings').getByText('Published library mappings',{exact:true}).isVisible(),true)
  assert.equal(await page.locator('#optional-settings #bridge-controls').isVisible(),true)
  await page.screenshot({path:`.ui-explorer/clipboard-organized-${colorScheme}-${width}.png`})
  if(!await page.locator('#paste-import').evaluate(node=>node.open))await page.locator('#paste-import > summary').click()
  await page.getByLabel('Design export',{exact:true}).fill('{"uixDesignExport":1,"plan":{}}')
  await audit()
  assert.equal(await page.locator('#import-progress').isVisible(),false)
  assert.deepEqual(errors,[])
  await page.close()
 }}finally{await browser.close()}
})

test('styled canvas dropdowns support keyboard selection and bounded menus in both themes', { timeout: 30_000 }, async () => {
 const browser=await chromium.launch()
 try{for(const colorScheme of ['light','dark'])for(const width of [540,400,320]){
  const page=await browser.newPage({viewport:{width,height:820},colorScheme})
  await page.setContent(fs.readFileSync('figma-plugin/ui.html','utf8'))
  await page.getByRole('button',{name:'Clipboard',exact:true}).click()
  assert.equal(await page.locator('#paste-import').evaluate(node=>node.open),false,'manual paste is disclosed only when requested')
  assert.equal(await page.locator('footer #build').isVisible(),false,'Clipboard has no detached footer action')
  if([540,320].includes(width))await page.screenshot({path:`.ui-explorer/clipboard-initial-${colorScheme}-${width}.png`})
  const destination=page.getByRole('combobox',{name:'Destination',exact:true})
  const textBounds=await destination.locator('.select-value').evaluate(node=>{
   const range=document.createRange();range.selectNodeContents(node)
   const ink=range.getBoundingClientRect(),box=node.getBoundingClientRect()
   return {text:node.textContent,visible:node.scrollWidth<=node.clientWidth,top:ink.top-box.top,bottom:box.bottom-ink.bottom}
  })
  assert.equal(textBounds.text,'Current open page')
  assert.equal(textBounds.visible,true,'the selected label fits without horizontal truncation')
  assert.ok(textBounds.top>=-.5&&textBounds.bottom>=-.5,'the whole text line, including descenders, fits: '+JSON.stringify(textBounds))
  await destination.press('Enter');await destination.press('ArrowDown')
  assert.equal(await page.locator('#placement').inputValue(),'current-page','navigation does not commit')
  await destination.press('Escape');assert.equal(await destination.getAttribute('aria-expanded'),'false')
  await destination.press('Enter');await destination.press('ArrowDown');await destination.press('Tab')
  assert.equal(await page.getByLabel('Destination name').isVisible(),true)
  assert.equal(await page.locator('#placement').inputValue(),'page')
  await destination.press('e');await destination.press('Enter')
  assert.equal(await page.locator('#placement').inputValue(),'section')
  await destination.click()
  await page.getByRole('listbox').evaluate(menu=>{const b=menu.getBoundingClientRect();if(b.left<11||b.right>innerWidth-11||b.top<11||b.bottom>innerHeight-11)throw Error('Menu overflow')})
  assert.equal(await page.getByRole('option',{selected:true}).count(),1)
  if(width===540)await page.screenshot({path:`.ui-explorer/handoff-dropdown-${colorScheme}.png`})
  await page.locator('h1').click();assert.equal(await destination.getAttribute('aria-expanded'),'false')
  await destination.click();await page.locator('#placement').evaluate(select=>{select.disabled=true})
  await page.locator('#placement-trigger:disabled').waitFor();assert.equal(await page.getByRole('listbox').count(),0)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await page.close()
 }}finally{await browser.close()}
})

test("sandboxed plugin identifies the required clipboard provider, supports explicit manual paste, and keeps destination errors distinct", { timeout: 30_000 }, async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    await page.setContent(`<iframe sandbox="allow-scripts allow-forms" style="width:400px;height:600px"></iframe><script>
      window.requests = [];
      window.addEventListener('message', (event) => {
        if (!event.data.pluginMessage) return;
        if (['connection-bootstrap','connection-context','save-connection','forget-connection'].includes(event.data.pluginMessage.type)) return;
        window.requests.push(event.data.pluginMessage);
        event.source.postMessage({pluginMessage: {type: 'result', report: ['Frame imported'], conflicts: [], warnings: []}}, '*');
      });
    </script>`)
    await page.locator("iframe").evaluate((iframe, html) => { iframe.srcdoc = html }, fs.readFileSync("figma-plugin/ui.html", "utf8"))
    const panel = page.frameLocator("iframe")
    await panel.getByRole("button", { name: "Clipboard", exact: true }).click()
    assert.equal(await panel.locator('#clipboard-intro #build-clipboard').isVisible(),true)
    assert.equal(await panel.locator('#paste-import #build-pasted').isVisible(),false,'the alternate action stays hidden until manual paste is expanded')
    assert.equal(await panel.locator('footer #build').isVisible(),false)
    const status = panel.locator("#status")
    await chooseDropdown(panel, "placement", "")
    await panel.getByRole("button", { name: "Build from clipboard", exact: true }).click()
    await panel.locator("#placement-trigger:focus").waitFor()
    assert.match(await status.innerText(), /Choose where/)
    assert.doesNotMatch(await status.innerText(), /clipboard/i)

    await chooseDropdown(panel, "placement", "current-page")
    await panel.getByRole("button", { name: "Build from clipboard", exact: true }).click()
    await panel.locator("#bridge-url:focus").waitFor()
    assert.equal(await panel.locator("#bridge-controls").getAttribute("open"), "")
    assert.match(await status.innerText(), /Connect the local bridge/)
    assert.equal(await status.getAttribute("data-tone"), "error")
    await panel.locator("#paste-import summary").click()
    assert.equal(await panel.locator('#paste-import #build-pasted').isVisible(),true)

    const plan = { components: [], frames: [{ scenarioId: "screen", width: 1440 }] }
    const raw = JSON.stringify({ uixDesignExport: 1, plan })
    await panel.locator("#payload").evaluate((textarea, raw) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData("text/plain", raw)
      textarea.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }))
    }, raw)
    assert.equal(await panel.locator("#payload").inputValue(), raw)
    assert.match(await status.innerText(), /Design pasted: 1 frame/)
    assert.equal(await page.evaluate(() => window.requests.length), 0, "pasting alone does not write to Figma")
    await panel.getByRole("button", { name: "Build pasted export", exact: true }).click()
    await panel.getByText("Frame imported", { exact: true }).waitFor()
    const requests = await page.evaluate(() => window.requests)
    assert.deepEqual(requests[0], { type: "build", plan, placement: { mode: "current-page", name: undefined }, libraries: undefined })

    await chooseDropdown(panel, "placement", "section")
    await panel.locator("#destination").fill("Existing section")
    await panel.locator("#destination").evaluate((input, raw) => {
      const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", raw)
      input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }))
    }, raw)
    assert.equal(await panel.locator("#destination").inputValue(), "Existing section", "design paste handler does not intercept other input fields")
  } finally { await browser.close() }
})

test("Build from clipboard works through the connected native provider with no paste gesture", { timeout: 30_000 }, async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    const plan = { components: [], frames: [{ scenarioId: "native-clipboard", width: 1440 }] }
    let reads = 0
    await page.route("http://localhost:5198/**", async (route) => {
      const request = route.request()
      const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-UIX-Client", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" }
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers })
      assert.equal(request.headers().authorization, "Bearer test-session")
      if (request.url().endsWith("/clipboard")) reads++
      const body = request.url().endsWith("/poll") ? [] : request.url().endsWith("/clipboard") ? { uixDesignExport: 1, plan } : { connected: true }
      await route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify(body) })
    })
    await page.setContent(`<iframe sandbox="allow-scripts allow-forms" style="width:400px;height:600px"></iframe><script>
      window.requests=[];
      window.addEventListener('message', event=>{ if (!event.data.pluginMessage) return; if (['connection-bootstrap','connection-context','save-connection','forget-connection'].includes(event.data.pluginMessage.type)) return; window.requests.push(event.data.pluginMessage);
        event.source.postMessage({pluginMessage:{type:'result',report:['Native clipboard imported'],conflicts:[],warnings:[]}},'*'); });
    </script>`)
    await page.locator("iframe").evaluate((iframe, html) => { iframe.srcdoc = html }, fs.readFileSync("figma-plugin/ui.html", "utf8"))
    const panel = page.frameLocator("iframe")
    await panel.getByRole("button", { name: "Clipboard", exact: true }).click()
    await chooseDropdown(panel, "placement", "current-page")
    if (!await panel.locator("#bridge-controls").getAttribute("open").then(value => value !== null)) await panel.locator("#bridge-controls > summary").click()
    await panel.getByRole("textbox", { name: "Bridge connection URL" }).fill("http://localhost:5198/#test-session")
    await panel.getByRole("button", { name: "Connect bridge", exact: true }).click()
    await panel.getByText("Connected. Build from clipboard is ready.", { exact: true }).waitFor()
    assert.equal(reads, 0, "connecting never reads the clipboard")
    await panel.getByRole("button", { name: "Build from clipboard", exact: true }).click()
    await panel.getByText("Native clipboard imported", { exact: true }).waitFor()
    assert.equal(reads, 1)
    assert.equal(await panel.locator("#payload").inputValue(), "", "no manual paste was involved")
    assert.equal((await page.evaluate(() => window.requests))[0].plan.frames[0].scenarioId, "native-clipboard")
  } finally { await browser.close() }
})

test('import codes load only prepared requests, retain canvas settings and stream/cancel jobs', {timeout:30000}, async()=>{
 const browser=await chromium.launch()
 try{
  const page=await browser.newPage({viewport:{width:540,height:820},colorScheme:'dark'})
  const token='abcdefghijklmnopqrstuvwx',requestId='abcdefghijklmnop',code=`UIX1:5198:${token}:${requestId}`
  let submitted=[],job=null,reads=0,catalogReads=0,interrupted=false
  await page.route('http://localhost:5198/**',async route=>{
   const req=route.request(),url=new URL(req.url()),headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers})
   assert.equal(req.headers().authorization,'Bearer '+token)
   let body={connected:true}
   if(url.pathname==='/catalog'){catalogReads++;body={}}
   if(url.pathname.startsWith('/handoffs/'))body={id:requestId,project:'Design team',createComponents:false,screenCount:2,widths:[1440,390],frameCount:4,screens:[{id:'role',title:'Role'},{id:'menu',title:'Menu'}],expiresAt:Date.now()+3600000}
   if(url.pathname==='/poll'){if(job?.state==='running'&&!interrupted){interrupted=true;return route.abort('failed')}body=[]}
   if(url.pathname==='/imports'){submitted.push(req.postDataJSON());job={id:String(submitted.length),state:'running',progress:{phase:'capturing',completed:0,total:2,message:'Capturing screens?'}};body={id:job.id};reads=0}
   if(url.pathname==='/imports/current'){if(job?.state==='running'&&++reads>2&&submitted.length===1)job={...job,state:'completed',progress:{phase:'completed',completed:4,total:4,message:'Finished'},result:{report:['Imported 4 frames'],warnings:[],conflicts:[],coverage:{missing:[],unexpected:[]}}};body=job}
   if(url.pathname==='/imports/cancel'){job={...job,state:'cancelled',progress:{phase:'cancelled',completed:0,total:1,message:'Cancelled'},error:'Import cancelled. Frames already created remain on the canvas.'};body={cancelling:true}}
   await route.fulfill({headers,contentType:'application/json',body:JSON.stringify(body)})
  })
  await page.setContent('<iframe sandbox="allow-scripts allow-forms" style="width:540px;height:820px;border:0"></iframe>')
  await page.locator('iframe').evaluate((iframe,html)=>{iframe.srcdoc=html},fs.readFileSync('figma-plugin/ui.html','utf8'))
  const panel=page.frameLocator('iframe')
  assert.equal(await panel.locator('#configuration').isVisible(),false)
  assert.equal(await panel.getByRole('combobox').count(),0,'no source browser in the plug-in')
  await panel.getByLabel('Import code',{exact:true}).fill('http://localhost:8443/__explorer/')
  await panel.getByRole('button',{name:'Load import',exact:true}).click()
  await panel.getByText('Paste an import code copied from Build in Figma in UI Explorer.',{exact:true}).first().waitFor()
  await panel.getByLabel('Import code',{exact:true}).evaluate((input,code)=>{const clipboardData=new DataTransfer();clipboardData.setData('text/plain',code);input.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData}))},code)
  await panel.getByText('Design team',{exact:true}).waitFor()
  await panel.locator('#request-structure').filter({hasText:'No components or instances'}).waitFor()
  assert.equal(catalogReads,0,'loading never fetches the full catalog')
  assert.equal(submitted.length,0,'loading a request does not write to Figma')
  assert.equal(await panel.locator('#configuration').isVisible(),true)
  assert.equal(await panel.locator('input[name="width"]').count(),0,'capture widths stay in Explorer')
  assert.equal(await panel.getByLabel('Spacing (px)').isVisible(),false)
  await panel.getByLabel('Import section',{exact:true}).fill('Hiring review')
  await panel.getByLabel('Columns',{exact:true}).fill('2')
  await chooseDropdown(panel,'layout','horizontal');assert.equal(await panel.locator('#columns-field').isVisible(),false)
  await chooseDropdown(panel,'layout','grid')
  await page.screenshot({path:'.ui-explorer/handoff-plugin-ready.png'})
  await panel.getByRole('button',{name:'Import screens',exact:true}).click()
  await panel.getByText('Connection interrupted. Retrying the same import; do not start another run.',{exact:true}).waitFor()
  await panel.getByText('Imported 4 frames',{exact:true}).waitFor()
  assert.equal(submitted[0].requestId,requestId);assert.equal(submitted[0].ids,undefined);assert.equal(submitted[0].widths,undefined);assert.equal(submitted[0].placement.container,'Hiring review');assert.equal(submitted[0].layout.columns,2)
  await panel.getByRole('button',{name:'Import screens',exact:true}).click()
  await panel.getByRole('button',{name:'Cancel import',exact:true}).click()
  await panel.getByText('Import cancelled. Frames already created remain on the canvas.',{exact:true}).first().waitFor()
  assert.equal(await panel.getByRole('button',{name:'Import screens',exact:true}).isEnabled(),true)
  await panel.getByRole('button',{name:'Change',exact:true}).click()
  assert.equal(await panel.getByLabel('Import code',{exact:true}).isVisible(),true)
  assert.equal(await panel.locator('#configuration').isVisible(),false)
 }finally{await browser.close()}
})

test('MCP-driven imports keep the panel busy through the whole batch and retain the final report', {timeout:30000}, async()=>{
 const browser=await chromium.launch()
 try{
  const page=await browser.newPage()
  const queue=[];let waiting=null
  await page.route('http://localhost:5198/**',async route=>{
   const req=route.request(),path=new URL(req.url()).pathname,headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization, Content-Type, X-UIX-Client','Access-Control-Allow-Methods':'POST, GET, OPTIONS'}
   if(req.method()==='OPTIONS')return route.fulfill({status:204,headers})
   let body={connected:true}
   if(path==='/catalog')body={project:'Fixture',baseUrl:'http://localhost',captureReady:true,scenarios:[],folders:[]}
   if(path==='/imports/current')body=null
   if(path==='/poll')body=queue.splice(0)
   if(path==='/result'){waiting?.(req.postDataJSON());waiting=null}
   await route.fulfill({status:200,headers,contentType:'application/json',body:JSON.stringify(body)})
  })
  await page.setContent(`<iframe sandbox="allow-scripts allow-forms" style="width:420px;height:680px"></iframe><script>window.addEventListener('message',event=>{const m=event.data.pluginMessage;if(!m)return;event.source.postMessage({pluginMessage:{type:'result',requestId:m.requestId,report:m.type==='build'?['Frame from MCP']:[],conflicts:[],warnings:[],...(m.type==='verify'?{coverage:{missing:[],unexpected:[]}}:{})}},'*')})</script>`)
  await page.locator('iframe').evaluate((iframe,html)=>{iframe.srcdoc=html},fs.readFileSync('figma-plugin/ui.html','utf8'))
  const panel=page.frameLocator('iframe')
  await panel.locator('#bridge-controls > summary').click();await panel.getByLabel('Bridge connection URL').fill('http://localhost:5198/#fixture');await panel.getByRole('button',{name:'Connect bridge',exact:true}).click()
  await panel.getByText('Connected. Build from clipboard is ready.',{exact:true}).waitFor()
  const send=command=>new Promise(resolve=>{waiting=resolve;queue.push({id:String(Math.random()),command})})
  await send({type:'begin-export',runId:'agent'})
  assert.equal(await panel.getByRole('button',{name:'Clipboard',exact:true}).isDisabled(),true)
  assert.equal(await panel.getByRole('button',{name:'Cancel import',exact:true}).isVisible(),false)
  await send({type:'build',runId:'agent',plan:{frames:[],components:[]},placement:{mode:'current-page'}})
  assert.match(await panel.locator('#status').innerText(),/MCP import running/)
  await send({type:'verify',runId:'agent',expected:[],placement:{mode:'current-page'}})
  await send({type:'end-export',runId:'agent'})
  await panel.getByText('Frame from MCP',{exact:true}).waitFor()
  assert.equal(await panel.getByRole('button',{name:'Clipboard',exact:true}).isEnabled(),true)
 }finally{await browser.close()}
})

test('expired and unavailable import codes leave settings hidden and explain how to recover', {timeout:30000},async()=>{
 const browser=await chromium.launch()
 try{
  const page=await browser.newPage()
  let unavailable=false
  await page.route('http://localhost:5198/**',async route=>{
   if(unavailable)return route.abort('failed')
   const path=new URL(route.request().url()).pathname
   if(path.startsWith('/handoffs/'))return route.fulfill({status:410,contentType:'application/json',body:JSON.stringify({error:'This import code has expired. Create a new code in UI Explorer.'})})
   return route.fulfill({contentType:'application/json',body:JSON.stringify(path==='/poll'?[]:path==='/imports/current'?null:{connected:true})})
  })
  await page.setContent(fs.readFileSync('figma-plugin/ui.html','utf8'))
  await page.getByLabel('Import code',{exact:true}).fill('UIX1:5198:abcdefghijklmnopqrstuvwx:abcdefghijklmnop')
  await page.getByRole('button',{name:'Load import',exact:true}).click()
  await page.getByText('This import code has expired. Create a new code in UI Explorer.',{exact:true}).first().waitFor()
  assert.equal(await page.locator('#configuration').isVisible(),false)
  unavailable=true
  await page.getByRole('button',{name:'Load import',exact:true}).click()
  await page.getByText('UI Explorer is unavailable. Keep it running and copy a new code from Build in Figma.',{exact:true}).first().waitFor()
  assert.equal(await page.locator('#configuration').isVisible(),false)
 }finally{await browser.close()}
})
