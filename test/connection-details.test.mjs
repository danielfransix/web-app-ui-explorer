import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { canvasConnections, crawl, createExplorer, describeConnection, serve } from '../dist/node/index.js'

const home={id:'home',title:'Home',group:'App',actions:[],source:'src/Home.tsx'}
const click=(selector,text)=>({kind:'click',selector,text})
test('connection evidence is compatible, honest, ordered and excludes filled values and selectors',()=>{
 const secret='private-password-example'
 const target={id:'app',title:'App',group:'App',parent:'home',actions:[{kind:'fill',selector:`input[data-secret="${secret}"]`,value:secret},click('button','Continue')]}
 const edge={source:'home',target:'app',label:'Continue'}
 const legacy=describeConnection(edge,home,target)
 assert.equal(legacy.evidence,'recipe')
 assert.equal(legacy.steps.length,2)
 assert.equal(legacy.steps[1].role,'button')
 assert.ok(!JSON.stringify(legacy).includes(secret))
 assert.ok(!JSON.stringify(legacy).includes('selector'))
 const unrelated=describeConnection(edge,{...home,actions:[click('#other','Other')]},target)
 assert.equal(unrelated.evidence,'unknown');assert.deepEqual(unrelated.steps,[])
 const custom=describeConnection({...edge,details:{description:'After the timeout',steps:[{type:'automatic',label:'Timer elapsed'}]}},home,target)
 assert.equal(custom.evidence,'provided');assert.equal(custom.steps[0].type,'automatic')
 const unknown=describeConnection({source:'home',target:'app'},home,{...target,actions:undefined})
 assert.equal(unknown.label,'View connection');assert.equal(unknown.evidence,'unknown')
 const ambiguous=describeConnection(edge,home,{...target,actions:[click('button .label','Continue')]})
 assert.equal(ambiguous.steps[0].role,undefined,'ancestor selectors do not establish the target role')
 const prefix={...home,actions:[click('button','Menu')]}
 const suffix=describeConnection(edge,prefix,{...target,actions:[...prefix.actions,click('a','Get the app')]})
 assert.equal(suffix.steps.length,1);assert.equal(suffix.steps[0].role,'link')
 const captured=describeConnection(edge,home,{...target,origin:'crawled',transition:{steps:[{type:'click',role:'link',label:'Get the app'}]}})
 assert.equal(captured.evidence,'captured');assert.equal(captured.steps[0].role,'link')
 const partial=describeConnection({...edge,details:{steps:[{label:'Imported action',value:secret},null]}},home,target)
 assert.equal(partial.steps[0].type,'unknown');assert.ok(!JSON.stringify(partial).includes(secret))
})

test('explicit parent details and distinct parallel connections survive normalization',()=>{
 const child={...home,id:'app',title:'App',parent:'home',trigger:'Old label'}
 const a={source:'home',target:'app',label:'Link',details:{steps:[{type:'click',role:'link'}]}}
 const b={source:'home',target:'app',label:'Keyboard',details:{steps:[{type:'key',label:'Enter'}]}}
 assert.deepEqual(canvasConnections([home,child],[a,b,a]),[a,b])
 assert.deepEqual(canvasConnections([home,child],[]),[{source:'home',target:'app',label:'Old label'}])
 assert.deepEqual(canvasConnections([home],[a]),[])
})

test('saved connection details survive the API and static snapshot, with a bounded inspector on a larger graph',{timeout:90000},async()=>{
 await fixture(async(root,target)=>{
  const scenarios=Array.from({length:120},(_,i)=>({id:`s${i}`,title:i<2?['Signup form','Welcome'][i]:`Page ${i}`,group:'App',source:i<2?'src/Signup.tsx':'src/Other.tsx',actions:[],...(i?{parent:'s0',trigger:`Open page ${i}`}:{})}))
  const description='Review the selected plan before submitting. '.repeat(80)
  const transitions=[{source:'s0',target:'s1',label:'Complete signup',details:{description,steps:[{type:'fill',role:'email',label:'Email address'},{type:'click',role:'button',label:'Submit'}]}}]
  fs.mkdirSync(path.join(root,'.ui-explorer'),{recursive:true})
  fs.writeFileSync(path.join(root,'.ui-explorer/scenarios.json'),JSON.stringify({version:1,generatedAt:new Date().toISOString(),baseUrl:target,startPath:'/',scenarios,transitions}))
  const offline=createExplorer({root,options:{mode:'auto',autoCapture:false}})
  const snapshot=JSON.parse(String(offline.snapshotFiles().get('__explorer/api/state.json')))
  assert.deepEqual(snapshot.transitions,transitions)
  await offline.dispose()
  const running=await serve({root,target,port:0,mode:'auto',autoCapture:false})
  const browser=await chromium.launch()
  try{
   const state=await(await fetch(running.url+'/__explorer/api/state')).json()
   assert.equal(canvasConnections(state.scenarios,state.transitions).length,119)
   assert.deepEqual(state.transitions,transitions)
   const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[]
   page.on('pageerror',e=>errors.push(e.message))
   await page.goto(running.url+'/__explorer/?view=canvas');await page.getByRole('checkbox').first().check()
   await page.waitForFunction(()=>document.querySelector('[data-layout-ready]')?.getAttribute('data-layout-ready')==='true'&&document.querySelectorAll('.design-flow-edge-label').length>0)
   await page.waitForTimeout(400)
   const index=await page.locator('.design-flow-edge-label').evaluateAll(labels=>{const canvas=document.querySelector('.react-flow__pane').getBoundingClientRect();return labels.findIndex(el=>{const r=el.getBoundingClientRect();return r.left>canvas.left+20&&r.right<canvas.right-20&&r.top>canvas.top+20&&r.bottom<canvas.bottom-60})})
   assert.ok(index>=0,'a label is reachable in the larger canvas')
   await page.locator('.design-flow-edge-label').nth(index).hover()
   await page.getByRole('dialog',{name:'Connection details'}).waitFor()
   assert.equal(await page.getByRole('dialog',{name:'Connection details'}).count(),1,'one inspector is shared by the graph')
   await page.mouse.move(0,0);await page.getByRole('dialog',{name:'Connection details'}).waitFor({state:'hidden'})
   await page.getByRole('button',{name:'Deselect all',exact:true}).click()
   await page.locator('.design-folder-row').filter({has:page.getByText('Signup',{exact:true})}).getByRole('checkbox').check()
   const label=page.getByRole('button',{name:'Connection from Signup form to Welcome: Complete signup',exact:true})
   await label.click()
   const panel=page.getByRole('dialog',{name:'Connection details'})
   await panel.getByText('Pinned',{exact:true}).waitFor()
   assert.equal(await panel.locator('ol li').count(),2)
   await page.setViewportSize({width:320,height:900})
   await page.waitForFunction(()=>{const r=document.querySelector('.design-connection-details')?.getBoundingClientRect();return r&&r.left>=0&&r.right<=innerWidth})
   await panel.locator('.design-connection-details__body').evaluate(el=>{el.scrollTop=el.scrollHeight})
   const close=panel.getByRole('button',{name:'Close connection details'})
   const box=await close.boundingBox(),panelBox=await panel.boundingBox()
   assert.ok(box.y>=panelBox.y&&box.y+box.height<=panelBox.y+panelBox.height,'Close remains reachable in long details')
   assert.equal(await panel.evaluate(el=>el.scrollWidth>el.clientWidth),false)
   await page.screenshot({path:'.ui-explorer/connection-details-sequence-320.png'})
   await close.click();await panel.waitFor({state:'hidden'})
   assert.deepEqual(errors,[])
  }finally{await browser.close();await running.close()}
 })
})

const html=body=>`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`
async function fixture(run){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-connection-'))
 const upstream=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html(req.url==='/app'?'<h1>App</h1>':`<h1>Home</h1><a href="/app">Get the app</a><button onclick="document.querySelector('[role=listbox]').hidden=false">Choose a plan</button><div role="listbox" hidden><button role="option" onclick="this.parentElement.hidden=true;document.querySelector('h1').textContent='Chosen plan'">Alpha</button></div><form onsubmit="event.preventDefault();this.hidden=true;document.querySelector('h1').textContent='Submitted'"><label>Email<input type="email" required></label><label>Password<input type="password" required></label><button>Continue</button></form>`))})
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve))
 try{await run(root,`http://127.0.0.1:${upstream.address().port}`)}finally{await new Promise(resolve=>upstream.close(resolve));fs.rmSync(root,{recursive:true,force:true})}
}

test('real crawls retain button, link, option and form-step evidence without values',{timeout:60000},async()=>{
 await fixture(async(_root,target)=>{
  const result=await crawl({baseUrl:target,maxStates:30,maxDepth:4,timeBudgetMs:25000,concurrency:1})
  const app=result.scenarios.find(s=>s.title==='App')
  assert.equal(app.transition.steps.at(-1).role,'link')
  const choice=result.scenarios.find(s=>s.title==='Chosen plan')
  assert.deepEqual(choice.transition.steps.map(s=>s.role),['button','option'])
  const submitted=result.scenarios.find(s=>s.title==='Submitted')
  assert.ok(submitted.transition.steps.some(s=>s.type==='fill'&&s.role==='password'))
  assert.equal(submitted.transition.steps.at(-1).role,'button')
  const summaries=JSON.stringify(submitted.transition)
  for(const action of submitted.actions.filter(a=>a.kind==='fill'))assert.ok(!summaries.includes(action.value),'entered values are not copied to evidence')
  assert.ok(!summaries.includes('selector'))
 })
})

test('edge details hover, pin, switch, survive virtualization and fit small viewports',{timeout:120000},async()=>{
 await fixture(async(root,target)=>{
  const long='A very long action label that must remain complete in the connection details'
  const scenarios=[home,{id:'app',title:'App',group:'App',source:'src/App.tsx',actions:[click('a','Get the app')]},{id:'legacy',title:'Legacy',group:'App',source:'src/Legacy.tsx',actions:[click('button',long)]}]
  const transitions=[{source:'home',target:'app',label:'Get the app',details:{steps:[{type:'click',role:'link',label:'Get the app'}]}},{source:'home',target:'legacy',label:long},{source:'app',target:'legacy',details:{steps:[{type:'automatic',label:'Timer elapsed'}]}},{source:'legacy',target:'home'},{source:'home',target:'app',label:'Use keyboard',details:{steps:[{type:'key',label:'Enter'}]}}]
  const running=await serve({root,target,port:0,mode:'manual',autoCapture:false,scenarios,transitions})
  const browser=await chromium.launch()
  try{
   const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[]
   page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message))
   await page.addInitScript(()=>{window.__testSources=[];const Native=window.EventSource;window.EventSource=class extends Native{constructor(...args){super(...args);window.__testSources.push(this)}}})
   let edited=false
   await page.route('**/__explorer/api/state',async route=>{const response=await route.fetch();const state=await response.json();if(edited)state.transitions[0]={...state.transitions[0],label:'Updated label',details:{steps:[{type:'click',role:'button',label:'Updated action'}]}};await route.fulfill({response,json:state})})
   await page.goto(running.url+'/__explorer/?view=canvas');await page.getByRole('checkbox').first().check()
   await page.waitForFunction(()=>document.querySelectorAll('.design-flow-edge-label').length===5)
   const first=()=>page.getByRole('button',{name:'Connection from Home to App: Get the app',exact:true})
   const panel=()=>page.getByRole('dialog',{name:'Connection details',exact:true})
   await first().hover();await panel().getByText('Click the “Get the app” link',{exact:true}).waitFor()
   await panel().hover();assert.equal(await panel().isVisible(),true,'pointer can enter the panel')
   await page.mouse.move(0,0);await panel().waitFor({state:'hidden'})
   await first().focus();await panel().waitFor()
   await first().press('Enter');await panel().getByText('Pinned',{exact:true}).waitFor()
   assert.equal(await panel().getByRole('button',{name:'Close connection details'}).evaluate(el=>el===document.activeElement),true)
   await page.mouse.move(0,0);await page.waitForTimeout(400);assert.equal(await panel().isVisible(),true)
   const automatic=page.getByRole('button',{name:'Connection from App to Legacy: Timer elapsed',exact:true})
   await automatic.hover();assert.equal(await panel().getByText('Click the “Get the app” link',{exact:true}).isVisible(),true,'hover cannot replace pinned evidence')
   await automatic.click();await panel().getByText('Automatic “Timer elapsed”',{exact:true}).waitFor()
   await page.keyboard.press('Escape');await panel().waitFor({state:'hidden'})
   await first().click();await panel().getByText('Pinned',{exact:true}).waitFor()
   const pane=page.locator('.react-flow__pane'),bounds=await pane.boundingBox()
   await page.mouse.move(bounds.x+30,bounds.y+30);await page.mouse.down();await page.mouse.move(bounds.x+2200,bounds.y+1800,{steps:12});await page.mouse.up()
   await page.waitForFunction(()=>document.querySelectorAll('.design-flow-edge-label').length===0)
   assert.equal(await panel().isVisible(),true,'pinned panel survives virtualized trigger removal')
   for(const width of [768,390,320]){
    await page.setViewportSize({width,height:900})
    await page.waitForFunction(()=>{const el=document.querySelector('.design-connection-details');if(!el)return false;const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight},null,{timeout:3000})
    const geometry=await panel().evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:el.scrollWidth>el.clientWidth}})
    assert.ok(geometry.left>=0&&geometry.right<=width&&geometry.top>=0&&geometry.bottom<=900,JSON.stringify(geometry));assert.equal(geometry.overflow,false)
    await page.screenshot({path:`.ui-explorer/connection-pinned-${width}.png`})
   }
   await page.getByRole('textbox',{name:'Search screen states'}).fill('Home')
   await panel().waitFor({state:'hidden'})
   await page.setViewportSize({width:1440,height:1000});await page.getByRole('textbox',{name:'Search screen states'}).fill('')
   await first().waitFor()
   edited=true;await page.evaluate(()=>window.__testSources.forEach(source=>source.dispatchEvent(new Event('state'))))
   const updated=page.getByRole('button',{name:'Connection from Home to App: Updated label',exact:true})
   await updated.waitFor();await updated.click();await panel().getByText('Click the “Updated action” button',{exact:true}).waitFor()
   await page.screenshot({path:'.ui-explorer/connection-details-desktop.png'})
   await panel().getByRole('button',{name:'Close connection details'}).click();await panel().waitFor({state:'hidden'})
   assert.equal(await updated.evaluate(el=>el===document.activeElement),true,'Close returns focus without reopening')
   const legacy=page.getByRole('button',{name:`Connection from Home to Legacy: ${long}`,exact:true})
   await legacy.click();await panel().getByText(long,{exact:true}).waitFor();await panel().getByText('From saved replay steps; control details may be incomplete.',{exact:true}).waitFor()
   await page.keyboard.press('Escape')
   const unknown=page.getByRole('button',{name:'Connection from Legacy to Home: View connection',exact:true})
   await unknown.click();await panel().getByText('The action type was not recorded for this connection.',{exact:true}).waitFor()
   await page.keyboard.press('Escape');await panel().waitFor({state:'hidden'})
   await unknown.focus();await unknown.press('Space');await panel().getByText('Pinned',{exact:true}).waitFor()
   await page.getByRole('button',{name:'Expand Home',exact:true}).click()
   await panel().waitFor({state:'hidden'})
   await page.getByRole('dialog',{name:'Home',exact:true}).waitFor()
   assert.deepEqual(errors,[])
  }finally{await browser.close();await running.close()}
  const touch=await chromium.launch()
  const touchServer=await serve({root,target,port:0,mode:'manual',autoCapture:false,scenarios:scenarios.slice(0,2),transitions:transitions.slice(0,1)})
  try{
   const page=await touch.newPage({viewport:{width:768,height:900},hasTouch:true,isMobile:true})
   await page.goto(touchServer.url+'/__explorer/?view=canvas');await page.getByRole('checkbox').first().check()
   const button=page.getByRole('button',{name:'Connection from Home to App: Get the app',exact:true})
   await button.tap();await page.getByRole('dialog',{name:'Connection details'}).getByText('Pinned',{exact:true}).waitFor()
  }finally{await touch.close();await touchServer.close()}
 })
})
