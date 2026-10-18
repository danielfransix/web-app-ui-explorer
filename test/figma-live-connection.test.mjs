import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import test from 'node:test'
import {WebSocketServer} from 'ws'
import {chromium} from 'playwright'

test('the real plugin UI retries ownership conflicts and resends an unacknowledged result without executing its command twice', {timeout:30000},async()=>{
 let connections=0,results=0,polls=0,httpResults=0
 const server=http.createServer((req,res)=>{
  if(req.url==='/poll')polls++
  if(req.url==='/result')httpResults++
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','*');res.setHeader('Access-Control-Allow-Methods','*')
  if(req.method==='OPTIONS'){res.writeHead(204).end();return}
  if(req.url==='/disconnect')res.statusCode=503
  const body=req.url==='/connect'?{connected:true,websocket:{path:'/socket',protocol:1}}:req.url==='/imports/current'?null:{connected:true}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body))
 })
 const wss=new WebSocketServer({server,path:'/socket'})
 wss.on('connection',socket=>socket.on('message',raw=>{
  const message=JSON.parse(raw.toString())
  if(message.type==='hello'){
   assert.equal(message.token,'abcdefghijklmnopqrstuv')
   connections++
   if(connections===1){socket.close(4409,'Another plugin is connected');return}
   socket.send(JSON.stringify({type:'ready',runId:null,commands:[],clients:[],needsReview:[]}))
   socket.send(JSON.stringify({type:'command',id:'write-once',command:{type:'build',plan:{frames:[],components:[]},placement:{mode:'current-page'}}}))
  }else if(message.type==='result'){
   results++
   if(results===1)socket.terminate()
   else socket.send(JSON.stringify({type:'result-ack',id:message.id,accepted:true}))
  }
 }))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const base=`http://localhost:${server.address().port}`
 const browser=await chromium.launch()
 try{
  const page=await browser.newPage({viewport:{width:540,height:820}})
  const errors=[];page.on('pageerror',error=>errors.push(error.message))
  await page.setContent(`<iframe sandbox="allow-scripts allow-forms" style="width:540px;height:820px;border:0"></iframe><script>
   window.executions=0;
   window.addEventListener('message',event=>{const m=event.data.pluginMessage;if(m?.type!=='build')return;window.executions++;event.source.postMessage({pluginMessage:{type:'result',requestId:m.requestId,report:['Written once'],warnings:[],conflicts:[]}},'*')});
  </script>`)
  await page.locator('iframe').evaluate((iframe,html)=>{iframe.srcdoc=html},fs.readFileSync('figma-plugin/ui.html','utf8'))
  const panel=page.frameLocator('iframe')
  await panel.locator('#bridge-controls > summary').click()
  await panel.getByLabel('Bridge connection URL').fill(base+'/#abcdefghijklmnopqrstuv')
  await panel.getByRole('button',{name:'Connect bridge',exact:true}).click()
  for(let i=0;i<100&&results<2;i++)await new Promise(resolve=>setTimeout(resolve,50))
  assert.ok(results>=2,'result stays queued across a lost socket acknowledgement')
  assert.equal(await page.evaluate(()=>window.executions),1)
  assert.equal(connections,3)
  assert.equal(polls,0);assert.equal(httpResults,0)
  await panel.getByText('Live connection ready.',{exact:true}).waitFor()
  await page.screenshot({path:'.ui-explorer/plugin-websocket-recovered.png'})
  await panel.getByRole('button',{name:'Disconnect bridge',exact:true}).click()
  await new Promise(resolve=>setTimeout(resolve,600))
  assert.equal(connections,3,'manual disconnect disables reconnect even when its HTTP request fails')
  assert.deepEqual(errors,[])
 }finally{await browser.close();for(const socket of wss.clients)socket.terminate();await new Promise(resolve=>wss.close(resolve));server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
