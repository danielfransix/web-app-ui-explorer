import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import uiExplorer from '../dist/node/vite.js'
import { parseImportCode } from '../dist/node/index.js'

async function fixture(run) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-connection-'))
 fs.writeFileSync(path.join(root,'index.html'),'<h1>Connection fixture</h1>')
 const server=await createServer({root,configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[uiExplorer({mode:'manual',autoCapture:false,scenarios:[{id:'home',title:'Home',group:'App',actions:[]}]})]})
 try{await server.listen();await run({root,base:`http://127.0.0.1:${server.httpServer.address().port}`})}
 finally{await server.close();fs.rmSync(root,{recursive:true,force:true})}
}

test('manual connection discovery starts one shared bridge without exposing its URL in catalog state',async()=>{
 await fixture(async({root,base})=>{
  const endpoint=base+'/__explorer/api/figma/connection'
  assert.equal((await fetch(endpoint)).status,405)
  assert.equal((await fetch(endpoint,{method:'POST',headers:{Origin:'https://other.example'}})).status,403)
  assert.equal(fs.existsSync(path.join(root,'.ui-explorer','bridge.json')),false)
  const responses=await Promise.all([1,2,3].map(()=>fetch(endpoint,{method:'POST'})))
  assert.ok(responses.every(response=>response.ok&&response.headers.get('cache-control')==='no-store'))
  const bodies=await Promise.all(responses.map(response=>response.json()))
  assert.equal(new Set(bodies.map(body=>body.connectionUrl)).size,1)
  const url=new URL(bodies[0].connectionUrl)
  assert.equal(url.hostname,'localhost');assert.equal(url.protocol,'http:');assert.ok(url.hash.length>22)
  const state=await(await fetch(base+'/__explorer/api/state')).text()
  assert.equal(state.includes(url.hash.slice(1)),false)
  const prepared=await(await fetch(base+'/__explorer/api/figma/imports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:['home'],widths:[390]})})).json()
  const code=parseImportCode(prepared.code)
  assert.equal(code.url,url.origin);assert.equal(code.token,url.hash.slice(1),'manual connections and import codes share the bridge')
  const connected=await fetch(url.origin+'/connect',{method:'POST',headers:{Authorization:'Bearer '+code.token,'Content-Type':'application/json','X-UIX-Client':'connection-fixture'},body:'{}'})
  assert.equal(connected.status,200)
 })
})

test('workspace connection disclosure creates and copies the URL, supports manual copy and recovers from errors', {timeout:60000},async()=>{
 await fixture(async({root,base})=>{
  const browser=await chromium.launch()
  try{
   const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']})
   const page=await context.newPage({viewport:{width:1440,height:900}})
   const errors=[];page.on('pageerror',error=>errors.push(error.message))
   await page.goto(base+'/__explorer/')
   await page.getByRole('button',{name:'Workspace overview',exact:true}).click()
   const trigger=page.getByRole('button',{name:'Figma connection',exact:true})
   assert.equal(await trigger.getAttribute('aria-expanded'),'false')
   assert.equal(fs.existsSync(path.join(root,'.ui-explorer','bridge.json')),false,'the bridge starts only when requested')
   await trigger.click()
   const field=page.getByLabel('Bridge connection URL',{exact:true})
   await field.waitFor()
   const url=await field.inputValue()
   assert.equal(await field.getAttribute('readonly'),'')
   await page.getByRole('button',{name:'Copy connection URL',exact:true}).click()
   await page.getByRole('button',{name:'Copied connection URL',exact:true}).waitFor()
   assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),url)
   for(const width of [1440,320]){
    await page.setViewportSize({width,height:900})
    await field.scrollIntoViewIfNeeded()
    assert.equal(await field.evaluate(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth}),true)
    await page.screenshot({path:`.ui-explorer/figma-connection-${width}.png`})
   }
   await page.evaluate(()=>{navigator.clipboard.writeText=async()=>{throw Error('denied')}})
   await page.getByRole('button',{name:'Copied connection URL',exact:true}).click()
   await page.getByRole('alert').filter({hasText:'Select the URL above'}).waitFor()
   assert.equal(await field.inputValue(),url)
   await field.focus()
   assert.equal(await field.evaluate(node=>node.selectionEnd-node.selectionStart),url.length)
   await trigger.click()
   await page.route('**/api/figma/connection',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Could not start the local bridge. Retry.'})}),{times:1})
   await trigger.click()
   await page.getByRole('alert').filter({hasText:'Could not start the local bridge'}).waitFor()
   await page.getByRole('button',{name:'Retry connection',exact:true}).click()
   await field.waitFor()
   assert.equal(await field.inputValue(),url)
   assert.deepEqual(errors,[])
  }finally{await browser.close()}
 })
})
