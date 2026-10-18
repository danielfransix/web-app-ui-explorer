import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {WebSocket} from 'ws'
import {startBridge,sendToBridge} from '../dist/node/index.js'

function inbox(socket){
 const messages=[],waiters=[]
 socket.on('message',raw=>{const message=JSON.parse(raw.toString());const at=waiters.findIndex(w=>w.type===message.type);if(at<0)messages.push(message);else waiters.splice(at,1)[0].resolve(message)})
 return type=>{const at=messages.findIndex(m=>m.type===type);if(at>=0)return Promise.resolve(messages.splice(at,1)[0]);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Missing '+type)),4000);waiters.push({type,resolve:value=>{clearTimeout(timer);resolve(value)}})})}
}
async function connect(bridge,clientId='plugin',activeIds=[],options={}){
 const socket=new WebSocket(bridge.url.replace('http:','ws:')+'/socket',options),next=inbox(socket)
 await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject)})
 socket.send(JSON.stringify({type:'hello',token:bridge.token,clientId,activeIds,context:{documentName:'Utilities',pageId:'1:2',pageName:'App'}}))
 const ready=await next('ready')
 return {socket,next,ready}
}
const build={type:'build',plan:{frames:[],components:[]},placement:{mode:'current-page'}}

test('a reopened plugin claims a closed session immediately, retains uncertain writes, and cannot displace a live owner', {timeout:15000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-ws-reopen-'))
 const bridge=await startBridge({root,port:0,reconnectMs:20000})
 let socket
 const post=client=>fetch(bridge.url+'/connect',{method:'POST',headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json','X-UIX-Client':client},body:'{}'})
 try{
  const first=await connect(bridge,'old-ui');socket=first.socket
  assert.equal((await post('new-ui')).status,409,'a live owner is protected')
  const rejected=assert.rejects(bridge.dispatch(build),/previous plugin session closed/)
  const mutation=await first.next('command')
  await new Promise(resolve=>{socket.once('close',resolve);socket.close(1001)})
  await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal((await sendToBridge(root)).reconnecting,true)
  assert.equal((await post('new-ui')).status,200,'reopening does not wait for the old session grace')
  await rejected
  const reopened=await connect(bridge,'new-ui');socket=reopened.socket
  assert.equal(reopened.ready.needsReview[0].id,mutation.id)
  assert.deepEqual(reopened.ready.commands,[],'old commands are never replayed to a new UI')
  const conflict=new WebSocket(bridge.url.replace('http:','ws:')+'/socket')
  await new Promise(resolve=>conflict.once('open',resolve))
  conflict.send(JSON.stringify({type:'hello',token:bridge.token,clientId:'other-file',activeIds:[]}))
  assert.equal(await new Promise(resolve=>conflict.once('close',resolve)),4409)
  assert.equal((await sendToBridge(root)).connected,true)
 }finally{socket?.terminate();await bridge.close();fs.rmSync(root,{recursive:true,force:true})}
})

test('a paused native operation keeps its socket until its command deadline rather than the idle heartbeat deadline', {timeout:15000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-ws-paused-'))
 const bridge=await startBridge({root,port:0,socketHeartbeatMs:20,timeoutMs:1000})
 let socket
 try{
  const session=await connect(bridge,'plugin',[],{autoPong:false});socket=session.socket
  const result=bridge.dispatch(build),message=await session.next('command')
  await new Promise(resolve=>setTimeout(resolve,150))
  const status=await sendToBridge(root)
  assert.equal(status.connected,true);assert.equal(status.responsive,false);assert.equal(status.pending,1)
  const closed=new Promise(resolve=>socket.once('close',resolve))
  socket.send(JSON.stringify({type:'result',id:message.id,result:{report:['finished after pause']}}))
  assert.deepEqual(await result,{report:['finished after pause']})
  await closed
  assert.match((await sendToBridge(root)).lastSocketClose.reason,/Heartbeat expired while idle/)
 }finally{socket?.terminate();await bridge.close();fs.rmSync(root,{recursive:true,force:true})}
})

test('WebSocket authenticates, pushes commands, reports phases and acknowledges repeated results', {timeout:15000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-ws-'))
 const bridge=await startBridge({root,port:0,heartbeatMs:30,socketHeartbeatMs:30})
 let socket
 try{
  const bad=new WebSocket(bridge.url.replace('http:','ws:')+'/socket')
  await new Promise(resolve=>bad.once('open',resolve));bad.send(JSON.stringify({type:'hello',token:'wrong',clientId:'bad'}))
  assert.equal(await new Promise(resolve=>bad.once('close',resolve)),4401)
  const session=await connect(bridge);socket=session.socket
  await new Promise(resolve=>setTimeout(resolve,120))
  const status=await sendToBridge(root)
  assert.equal(status.connected,true);assert.equal(status.transport,'websocket');assert.equal(status.destination.documentName,'Utilities')
  const command=bridge.dispatch(build), message=await session.next('command')
  socket.send(JSON.stringify({type:'progress',id:message.id,phase:'Building screen: Home'}))
  await new Promise(resolve=>setTimeout(resolve,20))
  assert.equal((await sendToBridge(root)).commands[0].phase,'Building screen: Home')
  socket.send(JSON.stringify({type:'result',id:message.id,result:{report:['done']}}))
  assert.deepEqual(await command,{report:['done']})
  assert.equal((await session.next('result-ack')).accepted,true)
  socket.send(JSON.stringify({type:'result',id:message.id,result:{report:['done']}}))
  assert.equal((await session.next('result-ack')).accepted,true,'lost acknowledgements can be retried')
 }finally{socket?.terminate();await bridge.close();fs.rmSync(root,{recursive:true,force:true})}
})

test('a reconnect resumes result delivery without replaying a delivered mutation', {timeout:15000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-ws-resume-'))
 const bridge=await startBridge({root,port:0,reconnectMs:1000})
 let socket
 try{
  const first=await connect(bridge);socket=first.socket
  const result=bridge.dispatch(build), message=await first.next('command')
  await new Promise(resolve=>{socket.once('close',resolve);socket.terminate()})
  await new Promise(resolve=>setTimeout(resolve,25))
  const resumed=await connect(bridge,'plugin',[message.id]);socket=resumed.socket
  assert.equal(resumed.ready.commands[0].id,message.id)
  assert.equal(resumed.ready.commands[0].delivered,true)
  let replayed=0;socket.on('message',raw=>{if(JSON.parse(raw.toString()).type==='command')replayed++})
  socket.send(JSON.stringify({type:'result',id:message.id,result:{report:['completed once']}}))
  assert.deepEqual(await result,{report:['completed once']})
  await resumed.next('result-ack')
  assert.equal(replayed,0)
  await new Promise(resolve=>{socket.once('close',resolve);socket.terminate()})
  await new Promise(resolve=>setTimeout(resolve,20))
  const disconnected=await fetch(bridge.url+'/disconnect',{method:'POST',headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json','X-UIX-Client':'plugin'},body:'{}'})
  assert.equal(disconnected.status,200,'explicit disconnect works during the socket reconnect window')
  assert.equal((await sendToBridge(root)).transport,null)
 }finally{socket?.terminate();await bridge.close();fs.rmSync(root,{recursive:true,force:true})}
})

test('uncertain writes block retries, survive bridge restart and require a reviewed outcome', {timeout:15000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'uix-ws-uncertain-'))
 let bridge=await startBridge({root,port:0,timeoutMs:100}),socket
 try{
  const first=await connect(bridge);socket=first.socket
  const command=bridge.dispatch(build)
  const rejected=assert.rejects(command,/timed out/)
  const message=await first.next('command')
  socket.send(JSON.stringify({type:'progress',id:message.id,phase:'Waiting for fonts'}))
  await rejected
  assert.equal((await sendToBridge(root)).needsReview[0].id,message.id)
  await assert.rejects(bridge.dispatch(build),/unknown outcome/)
  const headers={Authorization:'Bearer '+bridge.token,'Content-Type':'application/json'}
  const review=()=>fetch(bridge.url+'/commands/reviewed',{method:'POST',headers,body:JSON.stringify({ids:[message.id],reviewedInFigma:true})})
  assert.equal((await review()).status,409,'a command reported as running cannot be cleared')
  socket.terminate();await bridge.close()
  bridge=await startBridge({root,port:0,timeoutMs:1000})
  const fresh=await connect(bridge,'reopened-plugin');socket=fresh.socket
  assert.equal(fresh.ready.needsReview[0].id,message.id)
  assert.equal((await review()).status,200)
  assert.deepEqual((await sendToBridge(root)).needsReview,[])
 }finally{socket?.terminate();await bridge.close();fs.rmSync(root,{recursive:true,force:true})}
})
