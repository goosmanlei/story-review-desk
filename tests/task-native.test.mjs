import test from 'node:test';
import assert from 'node:assert/strict';
import {connectNative} from '../tools/task-native.mjs';

function fixture(options={}) {
 let hooks;const sent=[];
 const client=connectNative({socket:'/fixture/owned.sock',timeoutMs:100,transportFactory:h=>{hooks=h;return {socket:h.socket,ready:Promise.resolve(),send:async m=>{sent.push(m);},close(){}};},...options});
 return {client,sent,message:m=>hooks.onMessage(m),fail:e=>hooks.onFailure(e)};
}
test('server methods coexist with client responses, preserve typed IDs and send on the original connection',async()=>{
 const requests=[],notifications=[],f=fixture({onRequest:m=>requests.push(m),onNotification:m=>notifications.push(m)});
 const read=f.client.call('thread/read',{threadId:'owned'});await Promise.resolve();await Promise.resolve();
 f.message({id:1,method:'item/tool/requestUserInput',params:{threadId:'owned'}});
 f.message({id:'1',method:'item/tool/call',params:{threadId:'other'}});
 f.message({id:1,result:{thread:{id:'owned'}}});
 assert.equal((await read).thread.id,'owned');await f.client.flush();assert.equal(requests.length,2);
 f.message({method:'serverRequest/resolved',params:{requestId:1,threadId:'foreign'}});await f.client.flush();assert.equal(f.client.hasRequest(1),true);
 await f.client.respond(1,{answers:{q:{answers:['controlled fixture']}}});
 assert.equal(f.client.hasRequest(1),false);assert.equal(f.client.hasRequest('1'),true);
 await assert.rejects(f.client.respond(1,{}),/已失效|已发送/);
 f.message({method:'serverRequest/resolved',params:{requestId:'1',threadId:'other'}});await f.client.flush();assert.equal(f.client.hasRequest('1'),false);
 assert.equal(notifications.length,2);assert.equal(f.sent.filter(m=>m.id===1&&m.result).length,1);f.client.close();await f.client.flush();
});
test('disconnect rejects pending RPCs and invalidates server replies exactly once',async()=>{
 const failures=[],f=fixture({onRequest:()=>{},onDisconnect:e=>failures.push(e.message)});
 f.message({id:0,method:'item/tool/call',params:{}});await f.client.flush();
 const pending=f.client.call('turn/start',{});await Promise.resolve();
 f.fail(Error('fixture cable lost'));await assert.rejects(pending,/cable lost/);await f.client.flush();
 await assert.rejects(f.client.respond(0,{}),/已失效/);await assert.rejects(f.client.call('thread/read'),/已关闭/);
 f.client.close();await f.client.flush();assert.deepEqual(failures,['fixture cable lost']);
});
test('unsupported requests are explicitly declined by clients without a handler and notification persistence does not deadlock RPC responses',async()=>{
 const diagnostics=[],f=fixture({onDiagnostic:d=>diagnostics.push(d)});
 f.message({id:'unknown',method:'unknown/serverMethod',params:{}});await f.client.flush();
 assert.equal(f.sent[0].error.code,-32601);assert.equal(diagnostics[0].code,'UNHANDLED_SERVER_REQUEST');f.client.close();
 let g;g=fixture({onNotification:async()=>{const result=await g.client.call('thread/read');assert.equal(result.ok,true);}});
 g.message({method:'thread/started',params:{}});await new Promise(r=>setImmediate(r));
 g.message({id:g.sent[0].id,result:{ok:true}});await g.client.flush();g.client.close();
});
