import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import uiExplorer from '../dist/node/vite.js'
import { startBridge, exportScreens, selectScreens } from '../dist/node/index.js'

const node = {tag:'viewport',rect:{x:0,y:0,width:400,height:300},fills:[],children:[]}
test('layer-only batches skip component preparation and carry the mode to every frame command',async()=>{
 const commands=[]
 await exportScreens({root:'.',baseUrl:'http://localhost'}, {ids:['screen'],widths:[400,390],createComponents:false,placement:{mode:'current-page'}},async command=>{commands.push(command);return command.type==='verify'?{coverage:{missing:[],unexpected:[]}}:{}},{selected:[{id:'screen',title:'Screen',group:'App',actions:[]}],capture:async options=>options.widths.map(width=>({scenarioId:'screen',width,root:{...node,component:{id:'app',name:'App',framework:'react'}}}))})
 const builds=commands.filter(command=>command.type==='build')
 assert.equal(builds.length,2)
 assert.ok(builds.every(command=>command.plan.createComponents===false&&command.plan.components.length===0&&command.plan.frames.length===1))
})
test('local export has exact folder boundaries, stable order, unique widths and cleanup on failure/cancel', async()=>{
 const screens=[{id:'z',title:'Z',group:'G',source:'src/Role/z.tsx'},{id:'a',title:'A',group:'G',source:'src/Role/a.tsx',kind:'overlay'},{id:'wrong',group:'G',source:'src/RolesOther/file.tsx'}]
 assert.deepEqual(selectScreens(screens,{folder:'src\\Role'}).map(s=>s.id),['a','z'])
 assert.deepEqual(selectScreens(screens,{kind:'overlay'}).map(s=>s.id),['a'])
 assert.throws(()=>selectScreens(screens,{ids:['missing']}),/IDs do not exist/)
 const commands=[], captured=[]
 const dispatch=async command=>{commands.push(command);return command.type==='verify'?{coverage:{missing:[],unexpected:[]}}:{}}
 const capture=async options=>{captured.push(options);return options.widths.map(width=>({scenarioId:options.scenario.id,width,root:node}))}
 const input={widths:[390,1440,390],placement:{mode:'current-page',container:'Review'},layout:{mode:'grid',columns:2,gap:40}}
 const result=await exportScreens({root:'.',baseUrl:'http://localhost:1234'},input,dispatch,{selected:selectScreens(screens,{folder:'src/Role'}),capture})
 assert.equal(result.expectedFrames,4);assert.deepEqual(captured[0].widths,[1440,390]);assert.equal(commands.filter(c=>c.type==='arrange').length,1)
 assert.equal(commands[0].type,'begin-export');assert.equal(commands.at(-1).type,'end-export')
 const failed=[]
 await assert.rejects(exportScreens({root:'.',baseUrl:'http://localhost'},input,async c=>{failed.push(c.type);return {}},{selected:screens.slice(0,1),capture:async()=>{throw Error('capture failed')}}),/capture failed/)
 assert.deepEqual(failed,['begin-export','end-export'])
 await assert.rejects(exportScreens({root:'.',baseUrl:'http://localhost'},input,dispatch,{selected:screens.slice(0,1),capture:async()=>[{scenarioId:'z',width:1440,root:node}]}),/Capture coverage differs/)

 const aborted=new AbortController(), cancelled=[]
 await assert.rejects(exportScreens({root:'.',baseUrl:'http://localhost'},input,async c=>{cancelled.push(c.type);return {}},{selected:screens.slice(0,1),signal:aborted.signal,capture:async()=>{aborted.abort(Error('cancelled'));return [{scenarioId:'z',width:1440,root:node}]}}),/cancelled/)
 assert.deepEqual(cancelled,['begin-export','end-export'])
})

test('authenticated local catalog and async jobs capture registered states, verify pairs and cancel safely', {timeout:60000}, async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-local-'))
 fs.writeFileSync(path.join(root,'index.html'),'<h1>Local import fixture</h1>')
 const scenarios=[{id:'base',title:'Base screen',group:'G',source:'src/Role/Base.tsx',actions:[]},{id:'state',title:'Menu open',group:'G',source:'src/Role/Base.tsx',kind:'overlay',actions:[]}]
 const server=await createServer({root,configFile:false,logLevel:'error',server:{port:0},plugins:[uiExplorer({mode:'manual',autoCapture:false,scenarios})]})
 await server.listen()
 const bridge=await startBridge({root,port:0,baseUrl:`http://localhost:${server.httpServer.address().port}`})
 const headers={Authorization:`Bearer ${bridge.token}`,'Content-Type':'application/json','X-UIX-Client':'fixture'}
 const post=(route,body={},customHeaders=headers)=>fetch(bridge.url+route,{method:'POST',headers:customHeaders,body:JSON.stringify(body)})
 let stopped=false
 const commands=[],actual=[]
 const plugin=(async()=>{while(!stopped){const batch=await(await fetch(bridge.url+'/poll',{headers})).json();if(Array.isArray(batch)) for(const item of batch){commands.push(item.command);if(item.command.type==='build')actual.push(...item.command.plan.frames.map(({scenarioId,width})=>({scenarioId,width})));const result=item.command.type==='verify'?{coverage:{missing:[],unexpected:[]}}:{report:[],conflicts:[],warnings:[]};await post('/result',{id:item.id,result})}await new Promise(r=>setTimeout(r,15))}})()
 const waitJob=async()=>{for(let i=0;i<1000;i++){const job=await(await fetch(bridge.url+'/imports/current',{headers})).json();if(job?.state!=='running')return job;await new Promise(r=>setTimeout(r,25))}throw Error('job timed out')}
 try{
  assert.equal((await fetch(bridge.url+'/catalog')).status,401)
  assert.equal((await fetch(bridge.url+'/catalog',{headers})).status,409)
  await post('/connect')
  assert.equal((await fetch(bridge.url+'/catalog',{headers:{...headers,'X-UIX-Client':'other'}})).status,409)
  const catalog=await(await fetch(bridge.url+'/catalog',{headers})).json()
  assert.equal(catalog.captureReady,true);assert.equal(catalog.scenarios.length,2);assert.ok(catalog.folders.some(f=>f.folder.endsWith('/src/Role/')&&f.count===2))
  const input={ids:['base','state'],widths:[400,390],placement:{mode:'current-page',container:'Fixture'},layout:{mode:'grid',columns:2,gap:20}}
  assert.equal((await post('/imports',{...input,ids:['missing']})).status,400)
  assert.equal((await post('/imports',{...input,widths:[0]})).status,400)
  const response=await post('/imports',input);assert.equal(response.status,202)
  assert.equal((await post('/imports',input)).status,409)
  assert.equal((await post('/imports',{...input},{...headers,'X-UIX-Client':'other'})).status,409)
  const finished=await waitJob();assert.equal(finished.state,'completed',finished.error);assert.equal(finished.result.expectedFrames,4)
  assert.equal(actual.length,4);assert.deepEqual(finished.result.coverage,{missing:[],unexpected:[]});assert.equal(commands.at(-1).type,'end-export')
  const second=await(await post('/imports',input)).json()
  await post('/imports/cancel',{id:second.id})
  const cancelled=await waitJob();assert.equal(cancelled.state,'cancelled');assert.match(cancelled.error,/cancelled/);assert.equal(commands.at(-1).type,'end-export')
 }finally{stopped=true;await plugin;await bridge.close();await server.close();fs.rmSync(root,{recursive:true,force:true})}
})
