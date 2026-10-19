import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import uiExplorer from '../dist/node/vite.js'

const type = locator => locator.evaluate(node => {
 const s=getComputedStyle(node)
 return {size:parseFloat(s.fontSize),weight:Number(s.fontWeight),color:s.color}
})

async function aligned(dialog,selectors){
 const edges=await dialog.evaluate((node,selectors)=>selectors.map(selector=>node.querySelector(selector).getBoundingClientRect().left),selectors)
 assert.ok(Math.max(...edges)-Math.min(...edges)<1,'related outer edges align: '+JSON.stringify({selectors,edges}))
}

async function balancedClose(dialog){
 const button=dialog.getByRole('button',{name:'Close',exact:true})
 const measure=()=>button.evaluate(node=>{
  const button=node.getBoundingClientRect(),header=node.closest('.modal-master-header'),shell=node.closest('.modal-shell')
  const h=header.getBoundingClientRect(),s=shell.getBoundingClientRect(),hs=getComputedStyle(header),ss=getComputedStyle(shell)
  const icon=node.querySelector('svg').getBoundingClientRect()
  return {width:button.width,height:button.height,top:button.top-s.top-parseFloat(ss.borderTopWidth),right:s.right-parseFloat(ss.borderRightWidth)-button.right,bottom:h.bottom-parseFloat(hs.borderBottomWidth)-button.bottom,iconX:icon.left+icon.width/2-button.left-button.width/2,iconY:icon.top+icon.height/2-button.top-button.height/2}
 })
 const before=await measure()
 await button.hover()
 assert.deepEqual(await measure(),before,'hover preserves close-button geometry')
 assert.ok(before.width>=44&&before.width===before.height,'the close target is a generous square')
 assert.ok(Math.max(before.top,before.right,before.bottom)-Math.min(before.top,before.right,before.bottom)<.6,'close target has equal clearance from the top, right edge and divider: '+JSON.stringify(before))
 assert.ok(Math.abs(before.iconX)<.6&&Math.abs(before.iconY)<.6,'the close icon is centered in its target')
}

test('dialog titles, section headings, option labels and metadata retain distinct hierarchy across every modal', {timeout:60000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-hierarchy-'))
 fs.writeFileSync(path.join(root,'index.html'),'<h1>Hierarchy fixture</h1>')
 const scenario={id:'home',title:'Hiring home',group:'Hiring',source:'src/Home.tsx',actions:[]}
 const server=await createServer({root,configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0},plugins:[uiExplorer({mode:'manual',autoCapture:false,scenarios:[scenario]})]})
 let browser
 try{
  await server.listen();browser=await chromium.launch()
  const page=await browser.newPage({viewport:{width:1440,height:1000}})
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  const base=`http://127.0.0.1:${server.httpServer.address().port}`
  await page.goto(base+'/__explorer/')
  await page.getByRole('checkbox').first().click()
  await page.getByRole('checkbox',{name:'Select Hiring home for Figma',exact:true}).check()
  await page.getByRole('button',{name:'Build in Figma',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'Build in Figma',exact:true})
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:width===1440?1000:844})
   const title=await type(dialog.getByRole('heading',{name:'Build in Figma',level:2,exact:true}))
   const section=await type(dialog.getByRole('heading',{name:'Viewport widths',level:3,exact:true}))
   const widths=dialog.getByRole('combobox',{name:'Viewport widths',exact:true})
   await widths.click()
   const option=await type(dialog.locator('.multi-select__option-label').first())
   const meta=await type(dialog.locator('.multi-select__option-description').first())
   const field=await type(dialog.getByText('Additional widths',{exact:true}))
   assert.ok(title.size>section.size&&section.size>option.size&&option.size>meta.size,JSON.stringify({title,section,option,meta}))
   assert.ok(section.weight>option.weight&&option.weight>meta.weight,'weight reinforces the size hierarchy')
   assert.ok(section.size>field.size&&field.weight>=600,'field labels are subordinate to section headings')
   assert.notEqual(option.color,meta.color,'dimensions are secondary to option names')
   await widths.press('Escape')
   await balancedClose(dialog)
   await aligned(dialog,['.modal-header-title','.figma-export>.modal-description','.modal-section-title','#figma-viewport-widths','#figma-custom-widths','.modal-master-footer>button'])
   assert.equal(await dialog.locator('.modal-master-body').evaluate(node=>node.scrollWidth<=node.clientWidth),true)
   await dialog.locator('.modal-master-body').evaluate(node=>node.scrollTop=0)
   await page.screenshot({path:`.ui-explorer/modal-hierarchy-settings-${width}.png`})
  }
  await dialog.getByRole('button',{name:'Prepare 1 frame',exact:true}).click()
  await dialog.getByRole('heading',{name:'Your import is ready',level:3,exact:true}).waitFor()
  await balancedClose(dialog)
  await aligned(dialog,['.modal-header-title','.modal-section-title','.figma-export__summary','.modal-field-label','#figma-import-code','.modal-master-footer>button'])
  assert.ok((await type(dialog.locator('.modal-header-title'))).size>(await type(dialog.locator('.modal-section-title'))).size)
  await page.screenshot({path:'.ui-explorer/modal-hierarchy-ready-320.png'})
  await dialog.getByRole('button',{name:'Close',exact:true}).click()

  await page.setViewportSize({width:1440,height:1000})
  await page.getByRole('button',{name:'Expand Hiring home',exact:true}).click()
  const preview=page.getByRole('dialog',{name:'Hiring home',exact:true})
  await balancedClose(preview)
  const previewTitle=await type(preview.locator('.modal-header-title'))
  const control=await type(preview.getByRole('combobox',{name:'Preview viewport',exact:true}))
  assert.ok(previewTitle.size>control.size)
  await preview.locator('.design-copy-menu > button').click()
  const copyTitle=await type(preview.getByRole('heading',{name:'Copy settings',level:3,exact:true}))
  const copyOption=await type(preview.locator('.design-copy-menu__row').first())
  await preview.getByRole('button',{name:'Add custom size',exact:true}).click()
  await aligned(preview,['.design-copy-menu__panel>h3','.design-copy-menu__row','.design-copy-menu__divider','.design-copy-menu__add','.design-copy-menu__panel>.design-component-option','.design-copy-menu__action'])
  assert.ok(previewTitle.size>copyTitle.size&&copyTitle.size>copyOption.size)
  await page.screenshot({path:'.ui-explorer/modal-hierarchy-preview.png'})
  await preview.locator('.design-copy-menu > button').click()
  await preview.getByRole('button',{name:'Close',exact:true}).click()

  await page.route('**/api/state',async route=>{
   const response=await route.fetch(),body=await response.json()
   body.thumbnails={revision:body.revision,capturedAt:new Date().toISOString(),items:{},failed:{home:'The preview could not be captured.'}}
   await route.fulfill({response,json:body})
  })
  await page.reload()
  await page.getByRole('button',{name:'1 failed',exact:true}).click()
  const issues=page.getByRole('dialog',{name:'Issues',exact:true})
  assert.ok((await type(issues.getByRole('heading',{name:'Issues',level:2,exact:true}))).size>(await type(issues.getByRole('heading',{name:'Hiring home',level:3,exact:true}))).size)
  assert.ok((await type(issues.locator('.modal-section-title'))).size>(await type(issues.locator('.design-issue__reason'))).size)
  for(const width of [1440,320]){
   await page.setViewportSize({width,height:844})
   await balancedClose(issues)
   assert.equal(await issues.locator('.modal-master-body').evaluate(node=>node.scrollWidth<=node.clientWidth),true)
   await page.screenshot({path:`.ui-explorer/modal-hierarchy-issues-${width}.png`})
  }
  assert.deepEqual(errors,[])
 }finally{await browser?.close();await server.close();fs.rmSync(root,{recursive:true,force:true})}
})
