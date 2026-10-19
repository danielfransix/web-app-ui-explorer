import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import uiExplorer from '../dist/node/vite.js'
import { startBridge, parseImportCode } from '../dist/node/index.js'

async function fixture(run) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-handoff-'))
 fs.writeFileSync(path.join(root,'index.html'),'<h1>Prepared import</h1>')
 const scenarios=[{id:'home',title:'Home',group:'App',source:'src/Home/App.tsx',actions:[]},{id:'menu',title:'Menu open',group:'App',source:'src/Home/App.tsx',kind:'overlay',actions:[]},{id:'settings',title:'Settings',group:'Settings',source:'src/Settings/App.tsx',actions:[]}]
 const server=await createServer({root,configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[uiExplorer({mode:'manual',autoCapture:false,scenarios})]})
 try {await server.listen();await run({root,scenarios,base:`http://127.0.0.1:${server.httpServer.address().port}`})}
 finally {await server.close();fs.rmSync(root,{recursive:true,force:true})}
}

test('Explorer starts its own bridge and hands off a fixed selection; plugin overrides cannot expand it', {timeout:60000},async()=>{
 await fixture(async({root,base})=>{
  const prepare=body=>fetch(base+'/__explorer/api/figma/imports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  assert.equal((await prepare({ids:['missing'],widths:[400]})).status,400)
  assert.equal((await prepare({ids:['home'],widths:[0]})).status,400)
  assert.equal((await fetch(base+'/__explorer/api/figma/imports',{method:'POST',headers:{Origin:'https://other.example'},body:'{}'})).status,403)
  const response=await prepare({ids:['menu','home','menu'],widths:[390,400,390],labels:{400:'Compact'},createComponents:false})
  assert.equal(response.status,201)
  const handoff=await response.json(), connection=parseImportCode(handoff.code)
  assert.ok(handoff.code.length<100);assert.equal(handoff.summary.screenCount,2);assert.equal(handoff.summary.frameCount,4);assert.deepEqual(handoff.summary.widths,[400,390])
  assert.equal((await fetch(connection.url+'/handoffs/'+connection.requestId)).status,401)
  const headers={Authorization:'Bearer '+connection.token,'Content-Type':'application/json','X-UIX-Client':'fixture'}
  const post=(route,body={})=>fetch(connection.url+route,{method:'POST',headers,body:JSON.stringify(body)})
  await post('/connect')
  const summary=await(await fetch(connection.url+'/handoffs/'+connection.requestId,{headers})).json()
  assert.equal(summary.createComponents,false)
  assert.deepEqual(summary.screens.map(s=>s.id),['home','menu'])
  const commands=[], actual=[];let stopped=false
  const plugin=(async()=>{while(!stopped){const batch=await(await fetch(connection.url+'/poll',{headers})).json();if(Array.isArray(batch))for(const item of batch){commands.push(item.command);if(item.command.type==='build')actual.push(...item.command.plan.frames.map(f=>[f.scenarioId,f.width]));await post('/result',{id:item.id,result:item.command.type==='verify'?{coverage:{missing:[],unexpected:[]}}:{report:['Built'],warnings:[],conflicts:[]}})}await new Promise(r=>setTimeout(r,10))}})()
  try {
   const input={requestId:connection.requestId,ids:['settings'],widths:[900],createComponents:true,placement:{mode:'current-page',container:'Review'},layout:{mode:'grid',columns:2,gap:40}}
   assert.equal((await post('/imports',input)).status,202)
   let job
   for(let i=0;i<1200;i++){job=await(await fetch(connection.url+'/imports/current',{headers})).json();if(job?.state!=='running')break;await new Promise(r=>setTimeout(r,20))}
   assert.equal(job.state,'completed',job.error)
   assert.deepEqual(actual,[['home',400],['home',390],['menu',400],['menu',390]])
   assert.ok(commands.filter(command=>command.type==='build').every(command=>command.plan.createComponents===false),'the prepared layer-only choice cannot be overridden by the plugin')
   assert.equal(commands.at(-1).type,'end-export');assert.deepEqual(job.result.coverage,{missing:[],unexpected:[]})
   assert.equal((await post('/imports',input)).status,202,'same code supports re-import')
   const current=await(await fetch(connection.url+'/imports/current',{headers})).json();await post('/imports/cancel',{id:current.id})
   for(let i=0;i<100;i++){job=await(await fetch(connection.url+'/imports/current',{headers})).json();if(job.state!=='running')break;await new Promise(r=>setTimeout(r,20))}
   assert.equal(job.state,'cancelled')
  } finally {stopped=true;await plugin}
  assert.ok(fs.existsSync(path.join(root,'.ui-explorer','bridge.json')))
 })
})

test('handoff codes stay loopback-only and expired requests report an actionable error', async()=>{
 for(const code of ['https://example.com','UIX1:0:abcdefghijklmnopqrstuv:abcdefghijklmnop','UIX1:65536:abcdefghijklmnopqrstuv:abcdefghijklmnop','UIX1:5198:short:abcdefghijklmnop','UIX1:5198:abcdefghijklmnopqrstuv:../../etc/passwd'])assert.throws(()=>parseImportCode(code),/Paste an import code/)
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-expired-'))
 const bridge=await startBridge({root,port:0,baseUrl:'http://localhost',handoffTtlMs:1})
 try {
  const source={id:'home',title:'Home',source:'src/App.tsx',group:'App',actions:[]}
  const prepared=bridge.prepareImport({ids:['home'],widths:[400]},[source])
  const code=parseImportCode(prepared.code),headers={Authorization:'Bearer '+code.token,'X-UIX-Client':'fixture','Content-Type':'application/json'}
  source.title='Changed'
  await fetch(code.url+'/connect',{method:'POST',headers,body:'{}'})
  await new Promise(r=>setTimeout(r,5))
  const response=await fetch(code.url+'/handoffs/'+code.requestId,{headers})
  assert.equal(response.status,410);assert.match((await response.json()).error,/expired|earlier Explorer session/)
 }finally{await bridge.close();fs.rmSync(root,{recursive:true,force:true})}
})

test('Explorer folder selection creates a short code with a subset and custom widths; clipboard denial keeps code available', {timeout:60000},async()=>{
 await fixture(async({base})=>{
  const browser=await chromium.launch()
  try{
   const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']})
   const page=await context.newPage()
   await page.goto(base+'/__explorer/')
   await page.getByRole('checkbox').first().click()
   await page.getByRole('button',{name:'Select visible',exact:true}).click()
   await page.getByRole('checkbox',{name:'Select Menu open for Figma',exact:true}).uncheck()
   await page.getByRole('button',{name:'Build in Figma',exact:true}).click()
   const dialog=page.getByRole('dialog',{name:'Build in Figma'})
   await dialog.locator('.figma-export').evaluate(()=>document.fonts.ready)
   await page.screenshot({path:'.ui-explorer/handoff-explorer-selection.png'})
   await dialog.getByRole('combobox',{name:'Viewport widths',exact:true}).click()
   await dialog.getByRole('option',{name:/Mobile/}).click()
   await dialog.getByRole('combobox',{name:'Viewport widths',exact:true}).press('Escape')
   await dialog.getByLabel('Additional widths').fill('1366')
   await dialog.getByLabel('Additional widths').press('Enter')
   const components=dialog.getByRole('radiogroup',{name:'Create components?',exact:true})
   assert.equal(await components.getByRole('radio',{name:'Yes',exact:true}).isChecked(),true)
   await components.getByRole('radio',{name:'No',exact:true}).click()
   assert.equal(await components.getByRole('radio',{name:'No',exact:true}).isChecked(),true)
   await components.getByRole('radio',{name:'No',exact:true}).press('ArrowLeft')
   assert.equal(await components.getByRole('radio',{name:'Yes',exact:true}).isChecked(),true)
   await components.getByRole('radio',{name:'Yes',exact:true}).press('ArrowRight')
   assert.equal(await components.getByRole('radio',{name:'No',exact:true}).isChecked(),true)
   const request=page.waitForRequest(r=>r.url().endsWith('/api/figma/imports'))
   await dialog.getByRole('button',{name:'Prepare 6 frames',exact:true}).click()
   const submitted=(await request).postDataJSON();assert.deepEqual(submitted.ids,['home','settings']);assert.deepEqual(submitted.widths,[1440,390,1366]);assert.equal(submitted.createComponents,false)
   const code=dialog.getByRole('textbox',{name:'Import code',exact:true});await code.waitFor()
   await dialog.getByText('Regular editable layers. No components or instances will be created.',{exact:true}).waitFor()
   assert.ok((await code.inputValue()).length<100)
   await dialog.getByRole('button',{name:'Copy import code',exact:true}).click()
   assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),await code.inputValue())
   await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw Error('denied')}})
   await dialog.getByRole('button',{name:'Copied import code',exact:true}).click()
   await dialog.getByRole('alert').waitFor();assert.ok((await code.inputValue()).startsWith('UIX1:'))
   await page.screenshot({path:'.ui-explorer/handoff-explorer-ready.png'})
   for(const width of [540,320]){
    await page.setViewportSize({width,height:820})
    await dialog.locator('.modal-master-body').evaluate(body=>{if(body.scrollWidth>body.clientWidth)throw Error('Handoff dialog overflowed horizontally')})
    await page.screenshot({path:`.ui-explorer/handoff-explorer-ready-${width}.png`})
   }
  }finally{await browser.close()}
 })
})

test('card selections stay below thumbnails, survive browsing, and define the exact Figma batch', {timeout:60000},async()=>{
 await fixture(async({base})=>{
  const browser=await chromium.launch()
  try{
   const page=await browser.newPage({viewport:{width:1280,height:900}})
   await page.goto(base+'/__explorer/')
   await page.getByRole('checkbox').first().click()
   const home=()=>page.getByRole('checkbox',{name:'Select Home for Figma',exact:true})
   const menu=()=>page.getByRole('checkbox',{name:'Select Menu open for Figma',exact:true})
   const settings=()=>page.getByRole('checkbox',{name:'Select Settings for Figma',exact:true})
   const build=page.getByRole('button',{name:'Build in Figma',exact:true})
   assert.equal(await build.count(),0,'export appears only after an explicit screen selection')
   const checkDisclosure=async(view)=>{
    const checkbox=home(),card=page.locator(view==='gallery'?'.design-screen-card':'.design-flow-node').filter({has:checkbox})
    const title=card.locator(view==='gallery'?'.design-screen-card__title':'.design-flow-node__title')
    const opacity=()=>checkbox.locator('.design-screen-select__box').evaluate(node=>getComputedStyle(node).opacity)
    const textLeft=()=>title.evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);return range.getBoundingClientRect().left})
    await page.mouse.move(0,0)
    await page.getByRole('button',{name:'Workspace overview',exact:true}).focus()
    assert.equal(await opacity(),'0','unselected checkboxes stay hidden until the card is hovered')
    const before=await textLeft(),square=await checkbox.locator('.design-screen-select__box').boundingBox(),cardBefore=await card.boundingBox()
    assert.ok(Math.abs(before-square.x)<.6,'the default title starts on the shared left content edge, without a checkbox slot')
    await page.screenshot({path:`.ui-explorer/card-checkbox-idle-${view}.png`})
    await card.hover()
    assert.equal(await opacity(),'1')
    const selection=await checkbox.boundingBox(),revealed=await textLeft()
    assert.ok(revealed>before+20&&selection.x+selection.width<=revealed,'the revealed checkbox pushes the title to its right')
    assert.deepEqual(await card.boundingBox(),cardBefore,'only the caption content moves; the card geometry stays stable')
    await page.screenshot({path:`.ui-explorer/card-checkbox-hover-${view}.png`})
    await page.mouse.move(0,0)
    await checkbox.focus()
    await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab')
    assert.equal(await opacity(),'0','focus alone does not reveal an unchecked square')
    assert.ok(await checkbox.evaluate(node=>node.matches(':focus-visible')&&getComputedStyle(node).outlineStyle!=='none'),'keyboard focus retains a visible indicator')
    await checkbox.press('Space')
    await page.getByRole('button',{name:'Workspace overview',exact:true}).focus()
    assert.equal(await opacity(),'1','selected checkboxes remain visible outside hover and focus')
    assert.ok(Math.abs(await textLeft()-revealed)<.6,'the checked control keeps its space after hover ends')
    await checkbox.uncheck()
    await page.mouse.move(0,0)
    await page.getByRole('button',{name:'Workspace overview',exact:true}).focus()
    assert.equal(await opacity(),'0')
    assert.ok(Math.abs(await textLeft()-before)<.6,'the title returns to its left edge when selection is hidden')
   }
   await checkDisclosure('gallery')
   await home().check()
   assert.equal(await page.getByRole('dialog').count(),0,'selection does not open the thumbnail')
   await menu().focus();await menu().press('Space');assert.equal(await menu().isChecked(),true)
   await home().uncheck()
   await page.getByRole('textbox',{name:'Search screen states',exact:true}).fill('Settings')
   await settings().check()
   await page.getByRole('region',{name:'Screen selection'}).getByText('2 selected',{exact:true}).waitFor()
   await page.getByRole('textbox',{name:'Search screen states',exact:true}).fill('')
   assert.equal(await home().isChecked(),false);assert.equal(await menu().isChecked(),true)
   await page.getByRole('button',{name:'Canvas',exact:true}).click()
   await page.locator('.design-flow-canvas[data-layout-ready="true"]').waitFor()
   // Node layout is ready before fitView finishes animating the viewport.
   await page.locator('.react-flow__viewport').evaluate(viewport=>new Promise(resolve=>{
    let previous='',stableFrames=0
    const settled=()=>{
     const transform=getComputedStyle(viewport).transform
     stableFrames=transform===previous?stableFrames+1:0;previous=transform
     if(stableFrames>=4)resolve();else requestAnimationFrame(settled)
    }
    requestAnimationFrame(settled)
   }))
   await checkDisclosure('canvas')
   const positions=await page.locator('.react-flow__node').evaluateAll(nodes=>nodes.map(n=>n.style.transform))
   await home().check()
   assert.deepEqual(await page.locator('.react-flow__node').evaluateAll(nodes=>nodes.map(n=>n.style.transform)),positions,'selection does not rearrange the canvas')
   assert.equal(await page.getByRole('dialog').count(),0)
   await page.getByRole('button',{name:'Gallery',exact:true}).click()
   assert.equal(await home().isChecked(),true)
   await menu().uncheck()
   await page.reload()
   await home().waitFor();assert.equal(await home().isChecked(),true);assert.equal(await menu().isChecked(),false);assert.equal(await settings().isChecked(),true)
   for(const width of [1280,540,320]){
    await page.setViewportSize({width,height:900})
    await page.locator('.design-screen-card').evaluateAll(cards=>{for(const card of cards){
     const preview=card.querySelector('.design-screen-card__preview').getBoundingClientRect(),checkbox=card.querySelector('[role="checkbox"]').getBoundingClientRect(),body=card.querySelector('.design-screen-card__body').getBoundingClientRect(),title=card.querySelector('.design-screen-card__title').getBoundingClientRect()
     if(checkbox.top<preview.bottom||checkbox.bottom>body.bottom||checkbox.left<body.left)throw Error('Selection must stay in the caption below the full thumbnail')
     if(Math.abs(checkbox.top+checkbox.height/2-title.top-title.height/2)>.6)throw Error('Caption controls should be vertically centered')
     const square=card.querySelector('.design-screen-select__box').getBoundingClientRect(),path=card.querySelector('.design-screen-card__path').getBoundingClientRect()
     if(Math.abs(square.left-path.left)>.6)throw Error('The visible checkbox square must share the left edge of the text below it')
     const range=document.createRange();range.selectNodeContents(card.querySelector('.design-screen-card__title'))
     const textLeft=range.getBoundingClientRect().left,shown=getComputedStyle(card.querySelector('.design-screen-select__box')).opacity==='1'
     if(shown?checkbox.right>textLeft:Math.abs(textLeft-path.left)>.6)throw Error('Titles must start at the left edge unless a revealed checkbox needs space')
    }})
    await page.screenshot({path:`.ui-explorer/card-selection-${width}.png`})
   }
   await build.click()
   const dialog=page.getByRole('dialog',{name:'Build in Figma'})
   await dialog.getByRole('button',{name:/Review selection/}).click()
   const reviewed=dialog.getByRole('group',{name:'Screens to export'})
   await reviewed.waitFor()
   assert.equal(await reviewed.locator('.figma-export__screen').count(),2)
   assert.match(await reviewed.innerText(),/Home/)
   assert.doesNotMatch(await reviewed.innerText(),/Menu open/)
   const request=page.waitForRequest(r=>r.url().endsWith('/api/figma/imports'))
   await dialog.getByRole('button',{name:'Prepare 2 frames',exact:true}).click()
   assert.deepEqual((await request).postDataJSON().ids,['home','settings'])
   await dialog.getByRole('textbox',{name:'Import code',exact:true}).waitFor()
   await dialog.getByRole('button',{name:'Close',exact:true}).click()
   await page.getByRole('button',{name:'Clear selection',exact:true}).click()
   assert.equal(await build.count(),0)
   await page.getByRole('button',{name:'Select visible',exact:true}).click()
   assert.equal(await home().isChecked(),true);assert.equal(await menu().isChecked(),true);assert.equal(await settings().isChecked(),true)
   const touchContext=await browser.newContext({hasTouch:true,isMobile:true,viewport:{width:390,height:844}})
   try{
    const touchPage=await touchContext.newPage()
    await touchPage.goto(base+'/__explorer/')
    await touchPage.getByRole('checkbox').first().check()
    const touchSelection=touchPage.getByRole('checkbox',{name:'Select Home for Figma',exact:true})
    assert.equal(await touchSelection.locator('.design-screen-select__box').evaluate(node=>getComputedStyle(node).opacity),'0','unchecked squares are not permanently shown on touch devices')
    await touchSelection.tap()
    assert.equal(await touchSelection.isChecked(),true)
    assert.equal(await touchSelection.locator('.design-screen-select__box').evaluate(node=>getComputedStyle(node).opacity),'1','checked squares remain visible after tapping')
   }finally{await touchContext.close()}
  }finally{await browser.close()}
 })
})

test('old servers explain the restart requirement, plain-text failures recover, and text hovers never move controls', {timeout:60000},async()=>{
 await fixture(async({base})=>{
  const browser=await chromium.launch()
  try{
   const page=await browser.newPage({viewport:{width:1280,height:900}})
   page.setDefaultTimeout(5000)
   let oldServer=true,failRequest=true,importCalls=0
   await page.route('**/__explorer/api/state',async route=>{
    const response=await route.fetch(),state=await response.json()
    if(oldServer)delete state.capabilities
    await route.fulfill({response,json:state})
   })
   await page.route('**/__explorer/api/figma/imports',async route=>{
    importCalls++
    if(failRequest)await route.fulfill({status:404,contentType:'text/plain',body:'Not found'})
    else await route.continue()
   })
   await page.goto(base+'/__explorer/')
   await page.getByRole('checkbox').first().click()
   const visible=page.getByRole('button',{name:'Select visible',exact:true})
   const hoverStates=[]
   async function checkHover(button){
    await page.mouse.move(0,0)
    const before=await button.boundingBox()
    await button.hover()
    await button.evaluate(node=>Promise.all(node.getAnimations().map(animation=>animation.finished)))
    const after=await button.boundingBox()
    assert.deepEqual(after,before,'hover must not change geometry or shift adjacent content')
    hoverStates.push(await button.evaluate(node=>{const style=getComputedStyle(node);return {background:style.backgroundColor,color:style.color}}))
   }
   await checkHover(visible)
   await visible.click()
   await checkHover(page.getByRole('button',{name:'Clear selection',exact:true}))
   await page.getByRole('button',{name:'Expand Home',exact:true}).click()
   const preview=page.getByRole('dialog')
   await preview.getByRole('button',{name:'Build in Figma',exact:true}).click()
   const dialog=page.getByRole('dialog',{name:'Build in Figma',exact:true})
   await dialog.getByRole('alert').filter({hasText:"Restart your app's dev server"}).waitFor()
   assert.equal(await dialog.getByRole('button',{name:'Prepare 1 frame',exact:true}).isDisabled(),true)
   assert.equal(importCalls,0,'known older APIs are blocked before submission')
   await dialog.getByRole('button',{name:/Review selection/}).click()
   await checkHover(dialog.getByRole('button',{name:'Select all',exact:true}))
   await checkHover(dialog.getByRole('button',{name:'Clear',exact:true}))
   assert.ok(hoverStates.every(state=>JSON.stringify(state)===JSON.stringify(hoverStates[0])),JSON.stringify(hoverStates))
   oldServer=false
   await page.reload()
   const active=page.getByRole('dialog').filter({has:page.locator('.design-viewport-toolbar')})
   await active.getByRole('button',{name:'Build in Figma',exact:true}).click()
   const updated=page.getByRole('dialog',{name:'Build in Figma',exact:true})
   await updated.getByRole('button',{name:'Prepare 1 frame',exact:true}).click()
   const error=updated.getByRole('alert')
   await error.filter({hasText:"Restart your app's dev server"}).waitFor()
   assert.doesNotMatch(await error.innerText(),/Unexpected token|valid JSON/)
   failRequest=false
   await updated.getByRole('button',{name:'Prepare 1 frame',exact:true}).click()
   await updated.getByLabel('Import code',{exact:true}).waitFor()
   assert.ok((await updated.getByLabel('Import code',{exact:true}).inputValue()).startsWith('UIX1:'))
   assert.equal(importCalls,2)
  }finally{await browser.close()}
 })
})
