import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
// Full actual adapter + exact actual nested progress callback; no Bridge startup,
// SDK, model, transport, database or filesystem mutation. Source bytes use stdin.
const root=process.cwd(),files=['host/codex_conversation_bridge.py','host/codex_runtime_adapter.py'];
const sources=Object.fromEntries(files.map(file=>[file,fs.readFileSync(path.join(root,file),'utf8')]));
const python=String.raw`
import ast,asyncio,json,threading,time,types,sys
from pathlib import Path
from typing import Optional,Tuple
source=json.load(sys.stdin)
bridge=ast.parse(source['host/codex_conversation_bridge.py'])
parent=next(n for n in ast.walk(bridge) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and any(isinstance(x,ast.FunctionDef) and x.name=='progress' for x in n.body))
progress=next(n for n in parent.body if isinstance(n,ast.FunctionDef) and n.name=='progress')
initial=next(n for n in parent.body if isinstance(n,ast.AnnAssign) and isinstance(n.target,ast.Name) and n.target.id=='last_progress')
body='def factory(self,turn):\n    progress_sequence=0\n    progress_lock=threading.Lock()\n    claim_path=Path("/memory/claim")\n'
body+='    '+ast.unparse(initial)+'\n'
body+='\n'.join('    '+line for line in ast.unparse(progress).splitlines())+'\n    return progress\n'
writes=[]
def atomic_write_json(_path,payload):
    writes.append(payload.copy())
    time.sleep(0.001)
def utc_now(): return 'memory-clock'
exec(body,globals())
adapter=types.ModuleType('memory_adapter')
exec(compile(source['host/codex_runtime_adapter.py'],'codex_runtime_adapter.py','exec'),adapter.__dict__)
class Worker:
    paths={'root':Path('/memory')}
    def __init__(self): self.claims=0
    def verify_active_claim(self,*args): self.claims+=1;time.sleep(0.002)
async def scenario():
    worker=Worker();emit=factory(worker,{'turnId':'turn:memory','conversationId':'conversation:memory'})
    runtime=adapter.CodexRuntimeAdapter(types.SimpleNamespace())
    stream=asyncio.StreamReader();runtime.process=types.SimpleNamespace(stdout=stream)
    runtime.progress_handler=emit
    handle=adapter.RuntimeTurn(runtime,'thread:memory','turn:memory');runtime.handles[handle.id]=handle
    deltas=240
    for index in range(deltas):
        stream.feed_data((json.dumps({'method':'item/agentMessage/delta','params':{'threadId':handle.thread_id,'turnId':handle.id,'itemId':'answer','delta':str(index)+','}})+'\n').encode())
    answer=''.join(str(index)+',' for index in range(deltas))
    stream.feed_data((json.dumps({'method':'turn/completed','params':{'threadId':handle.thread_id,'turn':{'id':handle.id,'status':'completed'}}})+'\n').encode());stream.feed_eof()
    beats=[];stop=False
    async def heartbeat():
        while not stop:
            beats.append(time.monotonic());await asyncio.sleep(0)
    task=asyncio.create_task(heartbeat());await asyncio.sleep(0)
    started=time.monotonic();await runtime._read_loop();elapsed=time.monotonic()-started
    stop=True;await task
    completed=await handle.run()
    assert completed.final_response==answer and completed.status=='completed'
    after_burst_claims=worker.claims
    after_burst_writes=len(writes)
    emit('READING','正在阅读相关资料');emit('READING','正在阅读相关资料')
    emit('SEARCHING','正在检索同项目资料');emit('RESPONDING','正在整理回答与可采用草稿')
    assert [row['sequence'] for row in writes]==list(range(1,len(writes)+1))
    assert [row['phase'] for row in writes][-3:]==['READING','SEARCHING','RESPONDING']
    assert writes[-1]['message']=='正在整理回答与可采用草稿'
    return {'deltas':deltas,'answerBytes':len(answer),'elapsedSeconds':elapsed,'heartbeatTicksDuringBurst':len(beats),'burstClaimReads':after_burst_claims,'burstProgressWrites':after_burst_writes,'phaseTransitionTail':[row['phase'] for row in writes][-3:],'finalReplyPreserved':True}
print(json.dumps(asyncio.run(scenario())))
`;
test('UI progress coalesces duplicate deltas before transport, preserves phase changes/final reply, and buffered reader yields',()=>{
 const result=JSON.parse(execFileSync('python3',['-B','-c',python],{input:JSON.stringify(sources),encoding:'utf8',env:{PATH:process.env.PATH,LANG:'en_US.UTF-8'},timeout:10000}));
 console.log(JSON.stringify(result));assert.equal(result.burstClaimReads,1);assert.equal(result.burstProgressWrites,1);assert.ok(result.heartbeatTicksDuringBurst>=result.deltas,'Buffered messages must yield to heartbeat');assert.equal(result.finalReplyPreserved,true);assert.deepEqual(result.phaseTransitionTail,['READING','SEARCHING','RESPONDING']);
});
