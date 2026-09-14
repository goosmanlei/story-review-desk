import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {nativeSocket} from '../tools/native-socket.mjs';
import {connectNative,probeNative} from '../tools/task-native.mjs';

function frame(opcode,text,fin=true){const body=Buffer.from(text),header=Buffer.alloc(body.length<126?2:4);header[0]=(fin?128:0)|opcode;header[1]=body.length<126?body.length:126;if(body.length>=126)header.writeUInt16BE(body.length,2);return Buffer.concat([header,body]);}
async function fixture(t,{badHandshake=false,silent=false,respond}={}){
 const connections=new Set(),requests=[],controls=[];
 const server=net.createServer(socket=>{
  connections.add(socket);socket.on('close',()=>connections.delete(socket));socket.on('error',()=>{});
  let input=Buffer.alloc(0),upgraded=false;
  socket.on('data',data=>{
   input=Buffer.concat([input,data]);
   if(!upgraded){const end=input.indexOf('\r\n\r\n');if(end<0)return;const header=input.subarray(0,end).toString();assert.match(header,/^GET \/ HTTP\/1.1/);const key=/Sec-WebSocket-Key: (.+)\r\n/i.exec(header+'\r\n')[1];input=input.subarray(end+4);upgraded=true;if(silent)return;const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+(badHandshake?'bad':accept)+'\r\n\r\n');}
   while(input.length>=2){let size=input[1]&127,offset=2;assert.ok(input[1]&128,'Client frames must be masked');if(size===126){if(input.length<4)return;size=input.readUInt16BE(2);offset=4;}else if(size===127){if(input.length<10)return;size=Number(input.readBigUInt64BE(2));offset=10;}if(input.length<offset+4+size)return;const mask=input.subarray(offset,offset+4),payload=Buffer.from(input.subarray(offset+4,offset+4+size)),opcode=input[0]&15;input=input.subarray(offset+4+size);for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];if(opcode===10){controls.push(payload.toString());continue;}assert.equal(opcode,1);const request=JSON.parse(payload);requests.push(request);respond?.(request,socket);}
  });
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const client=connectNative({timeoutMs:1000,transportFactory:options=>nativeSocket({...options,connect:()=>net.createConnection({host:'127.0.0.1',port:server.address().port})})});
 t.after(async()=>{client.close();for(const socket of connections)socket.destroy();await new Promise(resolve=>server.close(resolve));});
 return {client,requests,controls};
}
test('native socket upgrades before JSON-RPC, masks messages and handles split frames, fragments and ping',async t=>{
 const {client,requests,controls}=await fixture(t,{respond(r,s){if(r.method==='initialize'){const text=JSON.stringify({id:r.id,result:{userAgent:'fixture'}});s.write(frame(1,text.slice(0,10),false));s.write(frame(9,'ping'));const tail=frame(0,text.slice(10));s.write(tail.subarray(0,1));setImmediate(()=>s.write(tail.subarray(1)));}else if(r.id)s.write(frame(1,JSON.stringify({id:r.id,result:{length:r.params.text.length}})));}});
 await client.initialize();assert.equal((await client.call('echo',{text:'参'.repeat(23000)})).length,23000);assert.equal(requests[0].method,'initialize');assert.equal(requests[1].method,'initialized');assert.deepEqual(controls,['ping']);
});
test('native socket rejects an invalid upgrade without sending initialize',async t=>{const {client,requests}=await fixture(t,{badHandshake:true});await assert.rejects(client.initialize(),/握手响应无效/);assert.equal(requests.length,0);});
test('native socket bounds handshake wait and rejects a dropped pending RPC',async t=>{
 const silent=await fixture(t,{silent:true});await assert.rejects(silent.client.initialize(),/握手超时/);
 const dropped=await fixture(t,{respond(r,s){s.end();}});await assert.rejects(dropped.client.initialize(),/连接已结束/);
});
test('native socket propagates RPC rejection and rejects oversized frames',async t=>{
 const rejected=await fixture(t,{respond(r,s){s.write(frame(1,JSON.stringify({id:r.id,error:{message:'Denied'}})));}});await assert.rejects(rejected.client.initialize(),/Denied/);
 const oversized=await fixture(t,{respond(r,s){const header=Buffer.alloc(10);header[0]=129;header[1]=127;header.writeBigUInt64BE(9000000n,2);s.write(header);}});await assert.rejects(oversized.client.initialize(),/大小限制/);
});
test('probe rejects a daemon that can only read the parent history, before any thread is created',async()=>{
 const calls=[];const client={initialize:async()=>{},close(){},async call(method){calls.push(method);if(method==='thread/read')return {thread:{id:'parent',status:{type:'notLoaded'}}};if(method==='thread/loaded/list')return {data:[],nextCursor:null};throw Error(method);}};
 const result=await probeNative({parentThreadId:'parent',probeRoot:'/fixture',availableSlots:3,clientFactory:()=>client});assert.equal(result.delegation,false);assert.equal(result.availableSlots,0);assert.match(result.limitation,/CURRENT_SESSION_NOT_OWNED/);assert.ok(!calls.includes('thread/start'));
});
test('probe requires loaded-list and thread status agreement, then verifies archive unload',async()=>{
 let childLoaded=false;const client={initialize:async()=>{},close(){},async call(method,params){if(method==='thread/read')return {thread:{id:params.threadId,status:{type:params.threadId==='parent'?'active':childLoaded?'idle':'notLoaded'},turns:[]}};if(method==='thread/loaded/list')return {data:['parent',...(childLoaded?['child']:[])]};if(method==='model/list')return {data:[{model:'gpt-6-astra',supportedReasoningEfforts:[{reasoningEffort:'ultra'}]}]};if(method==='thread/start'){childLoaded=true;return {thread:{id:'child'}};}if(method==='thread/archive'){childLoaded=false;return {};}if(method==='thread/goal/get')return {goal:null};if(method==='thread/backgroundTerminals/list')return {data:[]};throw Error(method);}};
 const result=await probeNative({parentThreadId:'parent',probeRoot:'/fixture',availableSlots:3,clientFactory:()=>client});assert.equal(result.closeVerified,true);assert.equal(result.parentLoaded,true);assert.equal(result.availableSlots,3);assert.equal(result.closureProbe.history,'PRESERVED');
});
