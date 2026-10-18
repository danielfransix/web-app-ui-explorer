import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { startBridge, sendToBridge } from "../dist/node/index.js"

test('a local project retains its pairing address and credential across a bridge restart', async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-pairing-'))
 let bridge=await startBridge({root,port:0})
 try{
  const first={url:bridge.url,token:bridge.token}
  await bridge.close()
  bridge=await startBridge({root,port:0})
  assert.equal(bridge.url,first.url);assert.equal(bridge.token,first.token)
  assert.equal((await sendToBridge(root)).connected,false,'remembering a pairing does not claim an open plugin')
  assert.equal((await fetch(bridge.url+'/status')).status,401,'discovery never exposes a connection credential')
 }finally{await bridge.close();fs.rmSync(root,{recursive:true,force:true})}
})

test('MCP presence is authenticated, independent of plugin connectivity, and expires after a lost client', async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-presence-'))
 const bridge=await startBridge({root,port:0,agentTtlMs:150})
 const headers={Authorization:`Bearer ${bridge.token}`,'Content-Type':'application/json','X-UIX-Client':'plugin'}
 const post=(route,body,auth=headers)=>fetch(bridge.url+route,{method:'POST',headers:auth,body:JSON.stringify(body)})
 try{
  assert.equal((await post('/agents/heartbeat',{id:'one',name:'Editor'},{})).status,401)
  assert.equal((await post('/agents/heartbeat',{id:'one',name:'Editor'})).status,200)
  assert.equal((await sendToBridge(root)).connected,false,'an MCP client does not imply an open plugin')
  assert.deepEqual((await sendToBridge(root)).mcpClients,[{id:'one',name:'Editor'}])
  assert.equal((await fetch(bridge.url+'/agents',{headers})).status,409,'only the connected plugin reads panel presence')
  await post('/connect',{})
  await post('/agents/heartbeat',{id:'two',name:'Second editor'})
  assert.equal((await(await fetch(bridge.url+'/agents',{headers})).json()).clients.length,2)
  await post('/agents/disconnect',{id:'one'})
  assert.deepEqual((await sendToBridge(root)).mcpClients,[{id:'two',name:'Second editor'}])
  await new Promise(resolve=>setTimeout(resolve,180))
  assert.deepEqual((await sendToBridge(root)).mcpClients,[])
  assert.equal((await sendToBridge(root)).connected,true,'stale MCP presence never disconnects the plugin')
 }finally{await bridge.close();fs.rmSync(root,{recursive:true,force:true})}
})

test("bridge authenticates, routes a real build/result, and rejects work after plugin disconnect", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-bridge-"))
  const bridge = await startBridge({ root, port: 0, timeoutMs: 3000 })
  const headers = { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json", "X-UIX-Client": "test-plugin" }
  try {
    assert.equal((await fetch(`${bridge.url}/status`)).status, 401)
    await assert.rejects(sendToBridge(root, { type: "verify", expected: [], placement: { mode: "current-page" } }), /No Figma plugin/)
    assert.equal((await fetch(`${bridge.url}/connect`, { method: "POST", headers, body: "{}" })).status, 200)
    assert.equal((await sendToBridge(root)).connected, true)
    const result = sendToBridge(root, { type: "build", plan: { frames: [], components: [] }, placement: { mode: "current-page" } })
    let commands = []
    for (let i = 0; i < 50 && !commands.length; i++) {
      commands = await (await fetch(`${bridge.url}/poll`, { headers })).json()
      if (!commands.length) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(commands[0].command.type, "build")
    await fetch(`${bridge.url}/result`, { method: "POST", headers, body: JSON.stringify({ id: commands[0].id, result: { report: ["built"], conflicts: [] } }) })
    assert.deepEqual(await result, { report: ["built"], conflicts: [] })
    const unfinished = sendToBridge(root, { type: "verify", expected: [], placement: { mode: "current-page" } })
    const failure = assert.rejects(unfinished, /disconnected|No Figma plugin/)
    await fetch(`${bridge.url}/disconnect`, { method: "POST", headers, body: "{}" })
    await failure
    assert.equal((await sendToBridge(root)).connected, false)
  } finally { await bridge.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test("native clipboard provider requires the connected authenticated plugin and never returns unrelated clipboard text", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-native-clipboard-"))
  let reads = 0
  let text = "private unrelated clipboard content"
  const bridge = await startBridge({ root, port: 0, readClipboard: async () => { reads++; return text } })
  const headers = { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json", "X-UIX-Client": "plugin" }
  const post = (route, customHeaders = headers) => fetch(`${bridge.url}${route}`, { method: "POST", headers: customHeaders, body: "{}" })
  try {
    assert.equal((await post("/clipboard", {})).status, 401)
    assert.equal((await post("/clipboard")).status, 409)
    assert.equal(reads, 0)
    await post("/connect")
    assert.equal((await post("/clipboard", { ...headers, "X-UIX-Client": "other" })).status, 409)
    assert.equal(reads, 0)
    const unrelated = await post("/clipboard")
    assert.equal(unrelated.status, 400)
    assert.doesNotMatch(await unrelated.text(), /private unrelated/)
    const plan = { components: [], frames: [{ scenarioId: "home", width: 1440, node: { tag: "body" } }] }
    text = JSON.stringify({ uixDesignExport: 1, plan })
    const response = await post("/clipboard")
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { uixDesignExport: 1, plan })
    assert.equal(reads, 2)
  } finally { await bridge.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test("an acknowledged build stays connected while Figma blocks its UI heartbeat, with an explicit disconnect still immediate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uix-busy-"))
  const bridge = await startBridge({ root, port:0, heartbeatMs:100, timeoutMs:2000 })
  const headers = {Authorization:`Bearer ${bridge.token}`,"Content-Type":"application/json","X-UIX-Client":"plugin"}
  const post=(route,body={})=>fetch(bridge.url+route,{method:"POST",headers,body:JSON.stringify(body)})
  try {
    await post("/connect"); await post("/busy",{active:true})
    await new Promise(resolve=>setTimeout(resolve,160))
    const status=await sendToBridge(root)
    assert.equal(status.connected,true); assert.equal(status.busy,true)
    await post("/disconnect"); assert.equal((await sendToBridge(root)).connected,false)
  } finally {await bridge.close();fs.rmSync(root,{recursive:true,force:true})}
})

test('bridge reserves an export across capture gaps, rejects competing work and releases failed runs', async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-run-lock-'))
 const bridge=await startBridge({root,port:0,timeoutMs:2000})
 const headers={Authorization:`Bearer ${bridge.token}`,'Content-Type':'application/json','X-UIX-Client':'fixture'}
 const post=(route,body={})=>fetch(bridge.url+route,{method:'POST',headers,body:JSON.stringify(body)})
 const acknowledge=async(command,result={})=>{
  const task=bridge.dispatch(command)
  for(let i=0;i<100;i++){
   const batch=await(await fetch(bridge.url+'/poll',{headers})).json()
   if(batch.length){await post('/result',{id:batch[0].id,result});return task}
   await new Promise(resolve=>setTimeout(resolve,5))
  }
  throw Error('No queued command')
 }
 try{
  await post('/connect')
  await acknowledge({type:'begin-export',runId:'one'})
  await assert.rejects(bridge.dispatch({type:'begin-export',runId:'two'}),/already running/)
  await assert.rejects(bridge.dispatch({type:'build',plan:{frames:[],components:[]},placement:{mode:'current-page'}}),/already running/)
  assert.equal((await post('/busy',{active:true})).status,409)
  assert.equal((await post('/imports',{ids:['a'],widths:[400],placement:{mode:'current-page'}})).status,409)
  await acknowledge({type:'end-export',runId:'one'})
  await acknowledge({type:'begin-export',runId:'two'},{error:'failed to pin page'})
  await acknowledge({type:'begin-export',runId:'three'})
  await acknowledge({type:'end-export',runId:'three'})
 }finally{await bridge.close();fs.rmSync(root,{recursive:true,force:true})}
})
