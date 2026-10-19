import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import uiExplorer from '../dist/node/vite.js'

test('100 selected screens stay compact; paginated review and width chips preserve exact export selections', {timeout:60000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-export-selection-'))
 fs.writeFileSync(path.join(root,'index.html'),'<h1>Bulk selection fixture</h1>')
 const scenarios=Array.from({length:100},(_,i)=>({id:`screen-${String(i).padStart(3,'0')}`,title:`Screen ${String(i).padStart(3,'0')}`,group:'Screens',source:'src/App.tsx',actions:[]}))
 const server=await createServer({root,configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[uiExplorer({mode:'manual',autoCapture:false,scenarios})]})
 let browser
 try{
  await server.listen();browser=await chromium.launch()
  const page=await browser.newPage({viewport:{width:1280,height:900}})
  page.setDefaultTimeout(7000)
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__explorer/`)
  await page.getByRole('checkbox').first().click()
  await page.getByRole('button',{name:'Select visible',exact:true}).click()
  await page.getByRole('button',{name:'Build in Figma',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Build in Figma',exact:true})
  const review=dialog.getByRole('button',{name:/100 screens selected/})
  assert.equal(await review.getAttribute('aria-expanded'),'false')
  assert.equal(await dialog.getByRole('group',{name:'Screens to export',exact:true}).count(),0,'the screen list is not shown up front')
  assert.ok(await dialog.locator('.figma-export__screen').count()<=8,'even the collapsed review mounts a bounded number of rows')
  for(const width of [1280,390,320]){
   await page.setViewportSize({width,height:900})
   assert.equal(await dialog.locator('.modal-master-body').evaluate(node=>node.scrollWidth<=node.clientWidth),true)
   await page.screenshot({path:`.ui-explorer/bulk-export-compact-${width}.png`})
  }
  await review.click()
  const search=dialog.getByRole('textbox',{name:'Search screens to export',exact:true})
  assert.ok(await search.evaluate(field=>{
   const panel=field.parentElement
   return panel.classList.contains('figma-export__review-panel')&&panel.querySelector('.figma-export__screens').parentElement===panel&&panel.querySelector('.figma-export__pagination').parentElement===panel
  }),'search, list and pagination belong directly to one disclosure panel')
  assert.equal(await dialog.locator('.figma-export__screen').count(),8)
  await dialog.getByRole('button',{name:'Next screen page',exact:true}).click()
  await dialog.getByText('9–16 of 100 screens',{exact:true}).waitFor()
  await search.fill('Screen 099')
  assert.equal(await dialog.locator('.figma-export__screen').count(),1)
  await dialog.getByText('1 of 1 screen',{exact:true}).waitFor()
  assert.equal(await dialog.getByRole('button',{name:'Next screen page',exact:true}).isDisabled(),true)
  await search.fill('missing screen')
  await dialog.getByText('No screens match your search.',{exact:true}).waitFor()
  await search.fill('')
  await dialog.getByText('1–8 of 100 screens',{exact:true}).waitFor()
  for(const width of [1280,768,390,320]){
   await page.setViewportSize({width,height:900})
   const layout=await dialog.evaluate(node=>{
    const left=selector=>node.querySelector(selector).getBoundingClientRect().left
    const field=node.querySelector('[aria-label="Search screens to export"]')
    return {
     row:left('.figma-export__screen strong'),count:left('.figma-export__pagination>span'),help:left('.figma-export__review-help'),
     search:field.getBoundingClientRect().left,
     width:node.getBoundingClientRect().width,overflow:node.querySelector('.modal-master-body').scrollWidth>node.querySelector('.modal-master-body').clientWidth
    }
   })
   assert.ok(Math.max(layout.row,layout.count,layout.help,layout.search)-Math.min(layout.row,layout.count,layout.help,layout.search)<1,'screen names, search field, count and help share a left edge: '+JSON.stringify(layout))
   assert.equal(layout.overflow,false)
   assert.equal(layout.width,Math.min(600,width-40),'the wider dialog still fits narrow viewports')
   await dialog.locator('.modal-master-body').evaluate(node=>node.scrollTop=0)
   await page.screenshot({path:`.ui-explorer/bulk-export-review-${width}.png`})
  }
  await review.click()
  const widths=dialog.getByRole('combobox',{name:'Viewport widths',exact:true})
  await widths.click()
  assert.equal(await dialog.getByRole('listbox').getAttribute('aria-multiselectable'),'true')
  assert.equal(await dialog.locator('.multi-select__checkbox').count(),3,'options show checkbox indicators')
  await dialog.getByRole('option',{name:/Mobile/}).click()
  assert.equal(await dialog.getByRole('listbox').isVisible(),true,'multi-selection keeps the menu open')
  assert.equal(await dialog.getByRole('option',{selected:true}).count(),2)
  await page.screenshot({path:'.ui-explorer/bulk-export-width-menu-320.png'})
  await widths.press('Escape')
  assert.equal(await dialog.isVisible(),true,'Escape closes the menu without closing the dialog')
  const input=dialog.getByLabel('Additional widths',{exact:true})
  await input.fill('1366, 1920, 1366, 390')
  assert.equal(await dialog.getByRole('button',{name:'Prepare 200 frames',exact:true}).isDisabled(),true,'uncommitted text cannot be silently omitted')
  await input.press('Enter')
  assert.equal(await input.inputValue(),'')
  assert.equal(await dialog.locator('.figma-export__chip').count(),4,'duplicate widths create one chip')
  await dialog.getByRole('button',{name:'Remove 1440px viewport width',exact:true}).click()
  await dialog.getByRole('button',{name:'Remove 390px viewport width',exact:true}).click()
  await input.fill('0, 9000, 1280');await input.press('Enter')
  await dialog.getByRole('alert').filter({hasText:'whole-number widths'}).waitFor()
  assert.equal(await dialog.locator('.figma-export__chip').count(),2,'invalid batches are rejected without partially adding widths')
  await input.fill(Array.from({length:11},(_,i)=>1001+i).join(', '));await input.press('Enter')
  await dialog.getByRole('alert').filter({hasText:'up to 12 widths'}).waitFor()
  assert.equal(await dialog.locator('.figma-export__chip').count(),2)
  await input.fill(Array.from({length:10},(_,i)=>1001+i).join(', '));await input.press('Enter')
  assert.equal(await dialog.locator('.figma-export__chip').count(),12)
  await widths.click()
  assert.equal(await dialog.getByRole('option',{name:/Desktop/}).getAttribute('aria-disabled'),'true')
  await widths.press('Escape')
  await dialog.getByRole('button',{name:'Remove 1920px viewport width',exact:true}).click()
  await widths.click()
  await dialog.getByRole('option',{name:/Desktop/}).click()
  await widths.press('Escape')
  assert.equal(await dialog.locator('.figma-export__chip').count(),12)
  await page.screenshot({path:'.ui-explorer/bulk-export-chips-320.png'})
  const request=page.waitForRequest(request=>request.url().endsWith('/api/figma/imports'))
  await dialog.getByRole('button',{name:'Prepare 1200 frames',exact:true}).click()
  const body=(await request).postDataJSON()
  assert.equal(body.ids.length,100);assert.equal(new Set(body.widths).size,12)
  assert.ok(body.widths.includes(1440)&&body.widths.includes(1366)&&!body.widths.includes(390)&&!body.widths.includes(1920))
  await dialog.getByRole('heading',{name:'Your import is ready',exact:true}).waitFor()
  await dialog.getByRole('button',{name:'Back to settings',exact:true}).click()
  const remove=dialog.getByRole('button',{name:/^Remove \d+px viewport width$/})
  while(await remove.count())await remove.first().click()
  await dialog.getByText('Choose at least one viewport width.',{exact:true}).waitFor()
  assert.equal(await dialog.getByRole('button',{name:'Prepare 0 frames',exact:true}).isDisabled(),true)
  await widths.click();await dialog.getByRole('option',{name:/Mobile/}).click();await widths.press('Escape')
  assert.equal(await dialog.getByRole('button',{name:'Prepare 100 frames',exact:true}).isEnabled(),true)
  assert.deepEqual(errors,[])
 }finally{await browser?.close();await server.close();fs.rmSync(root,{recursive:true,force:true})}
})
