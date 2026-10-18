import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { discoverFigmaDesktop } from '../dist/node/index.js'

test('desktop discovery performs the official MCP handshake and lists tools without invoking native operations', async()=>{
 const methods=[]
 const server=http.createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405).end();return}
  let body='';for await(const chunk of req)body+=chunk
  const message=JSON.parse(body);methods.push(message.method)
  if(message.id===undefined){res.writeHead(202).end();return}
  const result=message.method==='initialize'?{protocolVersion:'2024-11-05',serverInfo:{name:'desktop-fixture',version:'1'},capabilities:{tools:{}}}:{tools:[{name:'get_metadata',inputSchema:{type:'object'}}]}
  res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}))
 })
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const port=server.address().port
 try{
  const result=await discoverFigmaDesktop(port)
  assert.equal(result.available,true);assert.deepEqual(result.tools,['get_metadata'])
  assert.deepEqual(methods,['initialize','notifications/initialized','tools/list'])
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
 assert.equal((await discoverFigmaDesktop(port)).available,false,'closed desktop endpoints report unavailable')
})
