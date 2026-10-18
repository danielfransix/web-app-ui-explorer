import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import uiExplorer from '../dist/node/vite.js'

test('workbench discloses secondary actions, explains screen sources, and gives mobile search a full row', {timeout:60000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-toolbar-'))
 fs.writeFileSync(path.join(root,'index.html'),'<h1>Toolbar fixture</h1>')
 fs.mkdirSync(path.join(root,'.ui-explorer'))
 fs.writeFileSync(path.join(root,'.ui-explorer','scenarios.json'),JSON.stringify({version:1,scenarios:[{id:'auto-settings',title:'Discovered settings',group:'App',source:'src/Settings.tsx',actions:[]},{id:'auto-reports',title:'Discovered reports',group:'Reports',source:'src/Reports.tsx',actions:[]}]}))
 const server=await createServer({root,configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[uiExplorer({mode:'merge',autoCapture:false,scenarios:[{id:'registered-home',title:'Registered home',group:'App',source:'src/Home.tsx',actions:[]}]})]})
 let browser
 try{
  await server.listen();browser=await chromium.launch()
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[]
  page.on('pageerror',error=>errors.push(error.message))
  const base=`http://127.0.0.1:${server.httpServer.address().port}`
  await page.goto(base+'/__explorer/')
  await page.getByRole('checkbox').first().click()
  const header=page.locator('.design-workbench-header'),search=page.getByRole('textbox',{name:'Search screen states',exact:true})
  assert.equal(await header.getByRole('button').count(),1,'only Workspace remains in the idle header')
  assert.equal(await page.getByRole('button',{name:'Return to UI',exact:true}).count(),0)
  assert.equal(await page.getByRole('button',{name:'Build in Figma',exact:true}).count(),0)
  for(const width of [1440,1024,800,768,540,390,320]){
   await page.setViewportSize({width,height:900})
   await search.fill('Registered')
   const bounds=await search.evaluate(input=>{
    const rect=input.getBoundingClientRect(),field=input.parentElement.getBoundingClientRect(),tabs=document.querySelector('.design-workbench-views').getBoundingClientRect(),context=document.createElement('canvas').getContext('2d')
    context.font=getComputedStyle(input).font
    return {left:rect.left,right:rect.right,width:rect.width,fieldTop:field.top,fieldRight:field.right,tabBottom:tabs.bottom,placeholderWidth:context.measureText(input.placeholder).width,pageWidth:document.documentElement.scrollWidth,viewport:innerWidth}
   })
   assert.ok(bounds.left>=0&&bounds.right<=width&&bounds.right<=bounds.fieldRight,JSON.stringify(bounds))
   assert.ok(bounds.width>bounds.placeholderWidth+8,'the complete search prompt fits')
   assert.ok(bounds.pageWidth<=width,'the workbench must not scroll sideways')
   if(width<768)assert.ok(bounds.fieldTop>=bounds.tabBottom,'mobile search has its own row')
   await search.fill('')
   await page.evaluate(()=>scrollTo(0,0))
   if([1440,390,320].includes(width))await page.screenshot({path:`.ui-explorer/toolbar-${width}.png`})
  }
  await page.getByRole('button',{name:'Workspace overview',exact:true}).click()
  const panel=page.getByLabel('Workspace overview',{exact:true}).filter({has:page.getByRole('heading',{name:'Workspace overview',exact:true})})
  await panel.waitFor()
  await panel.getByText('Screens and states defined in your project’s Explorer setup.',{exact:true}).waitFor()
  await panel.getByText('States found automatically by exploring your app.',{exact:true}).waitFor()
  const sources=panel.getByRole('radiogroup',{name:'Screen sources',exact:true})
  assert.equal(await sources.getByRole('radio').count(),3)
  assert.equal(await sources.getByRole('radio',{name:'Registered',exact:true}).isChecked(),true)
  const assertTotals=async(label,expected)=>{
   const card=sources.locator('.design-origin-card').filter({has:page.getByRole('radio',{name:label,exact:true})})
   const totals=card.getByRole('group',{name:`${label} catalog totals`,exact:true})
   assert.deepEqual(await totals.locator('strong').allTextContents(),expected.map(String))
   assert.equal(await panel.locator('.design-workbench-metrics').count(),1,'only the selected card discloses its totals')
   const heights=await sources.locator('.design-origin-card').evaluateAll(cards=>cards.map(card=>({selected:card.dataset.selected==='true',height:card.getBoundingClientRect().height})))
   assert.ok(heights.filter(card=>!card.selected).every(card=>card.height<heights.find(card=>card.selected).height),'the selected card expands to contain its totals')
   assert.ok(await totals.evaluate(node=>{const r=node.getBoundingClientRect(),card=node.closest('.design-origin-card').getBoundingClientRect();return r.left>=card.left&&r.right<=card.right&&r.bottom<=card.bottom}),'totals stay inside their source card')
  }
  await assertTotals('Registered',[1,1,0])
  for(const width of [320,1440]){
   await page.setViewportSize({width,height:900})
   const geometry=await panel.evaluate(node=>{
    const b=node.getBoundingClientRect(),left=node.querySelector('h2').getBoundingClientRect().left
    const aligned=['.design-workspace-label','.design-origin-options','.design-workspace-actions button','.design-workspace-shortcuts summary'].flatMap(selector=>Array.from(node.querySelectorAll(selector)))
    const rows=Array.from(node.querySelectorAll('.design-origin-option')).map(row=>{
     const r=row.getBoundingClientRect(),circle=row.querySelector('.ds-radio-circle').getBoundingClientRect(),text=row.querySelector('strong').getBoundingClientRect()
     return {textLeft:text.left,circleRight:circle.right,inset:r.right-circle.right,centerOffset:Math.abs((r.top+r.bottom-circle.top-circle.bottom)/2)}
    })
    const border=getComputedStyle(node.querySelector('.design-origin-options'))
    return {inside:b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight,offsets:aligned.map(el=>el.getBoundingClientRect().left-left),rows,borderWidth:border.borderTopWidth,borderStyle:border.borderTopStyle}
   })
   assert.equal(geometry.inside,true,'Workspace panel stays within the viewport')
   assert.ok(geometry.offsets.every(offset=>Math.abs(offset)<1),`outer elements share one left edge: ${JSON.stringify(geometry)}`)
   assert.equal(geometry.borderWidth,'1px')
   assert.equal(geometry.borderStyle,'solid')
   assert.ok(geometry.rows.every(row=>row.inset>=12&&row.centerOffset<1&&row.textLeft===geometry.rows[0].textLeft&&row.circleRight===geometry.rows[0].circleRight),'option text and right-hand radios align')
   await sources.getByRole('radio',{name:'All screens',exact:true}).hover()
   assert.equal(await sources.getByRole('radio',{checked:true}).count(),1,'hover does not change the selected source')
   await page.screenshot({path:`.ui-explorer/workspace-sources-${width}.png`})
  }
  await sources.getByRole('radio',{name:'Registered',exact:true}).focus()
  await page.keyboard.press('ArrowDown')
  assert.equal(await sources.getByRole('radio',{name:'Discovered',exact:true}).isChecked(),true,'arrow keys select the next source')
  await assertTotals('Discovered',[2,2,0])
  await page.getByRole('button',{name:'Expand Discovered settings',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Expand Registered home',exact:true}).count(),0)
  await sources.getByRole('radio',{name:'All screens',exact:true}).click()
  assert.equal(await sources.getByRole('radio',{checked:true}).count(),1)
  await assertTotals('All screens',[3,2,0])
  await page.getByRole('button',{name:'Expand Registered home',exact:true}).waitFor()
  await page.getByRole('button',{name:'Expand Discovered settings',exact:true}).waitFor()
  let discovered=false
  await page.route('**/__explorer/api/crawl',async route=>{discovered=true;await route.fulfill({contentType:'application/json',body:'{"started":true}'})})
  await panel.getByRole('button',{name:'Explore this app',exact:true}).click()
  assert.equal(discovered,true)
  await page.getByRole('checkbox',{name:'Select Registered home for Figma',exact:true}).check()
  assert.equal(await page.getByRole('region',{name:'Screen selection'}).getByRole('button',{name:'Build in Figma',exact:true}).isVisible(),true)
  assert.equal(await header.getByRole('button',{name:'Build in Figma',exact:true}).count(),0)
  await page.route('**/__explorer/api/state',async route=>{
   const response=await route.fetch(),body=await response.json()
   body.jobs.crawl={status:'running',progress:{states:12345}}
   await route.fulfill({response,json:body})
  })
  await page.setViewportSize({width:320,height:900})
  await page.reload()
  await header.getByRole('status',{name:'Exploring',exact:true}).waitFor()
  assert.equal(await header.getByRole('button',{name:'Stop exploring',exact:true}).isVisible(),true)
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'busy status also fits at 320px')
  assert.deepEqual(errors,[])
 }finally{await browser?.close();await server.close();fs.rmSync(root,{recursive:true,force:true})}
})
