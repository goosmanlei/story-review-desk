import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough,Writable} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {runAttach,renderAttachSnapshot,AttachInputDecoder} from '../tools/task-attach.mjs';

const exec=promisify(execFile);
const clone=value=>structuredClone(value);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,{timeout=2000}={}) {
 const started=Date.now();
 while(Date.now()-started<timeout){const value=await check();if(value)return value;await delay(10);}
 throw Error('timed out waiting for attach fixture');
}

class TtyInput extends PassThrough {
 constructor(){super();this.isTTY=true;this.raw=[];}
 setRawMode(value){this.raw.push(value);return this;}
}
class TtyOutput extends Writable {
 constructor(){super();this.isTTY=true;this.value='';}
 _write(chunk,encoding,callback){this.value+=chunk.toString();callback();}
}

function baseSnapshot() {
 return {
  task:{id:'task-a',displayId:'T-20260915-001',title:'终端隔离任务',status:'RUNNING',checkpoint:{summary:'已准备'}},
  nodes:[
   {id:'worker-root',parentAssignmentId:null,role:'worker',title:'主工作节点',status:'RUNNING',model:'gpt-test',effort:'high',canSend:true,reason:null,messages:[{id:'m-1',type:'agentMessage',text:'已有完整输出'}]},
   {id:'worker-child',parentAssignmentId:'worker-root',role:'worker',title:'子工作节点',status:'idle',model:'gpt-test',effort:'medium',canSend:true,reason:null,messages:[{id:'tool-1',type:'toolEvent',text:'工具事件完整参数'}]},
  ],
  decisions:[],connection:{status:'CONNECTED',reason:null},
 };
}

function harness(initial=baseSnapshot(),details={}) {
 let current=clone(initial),closed=0;
 const sent=[],answered=[],shown=[];
 const client={
  async snapshot(){return clone(current);},
  async send(request){sent.push(clone(request));return {status:'SENT',message:'消息已发送',operationId:request.operationId};},
  async showDecision(id){shown.push(id);return clone(details[id]||{decision:current.decisions.find(d=>d.id===id)});},
  async answer(request){answered.push(clone(request));current.decisions=current.decisions.map(d=>d.id===request.decisionId?{...d,status:'RESOLVED'}:d);return {status:'ANSWERED',operationId:request.operationId};},
  async close(){closed++;},
 };
 return {client,sent,answered,shown,get snapshot(){return current;},set snapshot(value){current=clone(value);},get closed(){return closed;}};
}

function start(h,{readOnly=false,pollIntervalMs=30}={}) {
 const input=new TtyInput(),output=new TtyOutput();let sequence=0;
 const result=runAttach('/fixture','task-a',{input,output,readOnly,pollIntervalMs,openClient:async()=>h.client,operationId:prefix=>`${prefix}-test-${++sequence}`,now:()=> '2026-09-15T10:00:00.000Z'});
 return {input,output,result};
}

test('raw decoder preserves split UTF-8 bracketed paste and submits only on the later Enter',()=>{
 let draft='',submitted=0,detached=0;
 const decoder=new AttachInputDecoder({onText:value=>{draft=value===null?draft.slice(0,-1):draft+value;},onSubmit:()=>submitted++,onDetach:()=>detached++});
 const bytes=Buffer.from(`${'\u001b[200~'}中文第一行\n第二行${'\u001b[201~'}`);
 decoder.write(bytes.subarray(0,4));decoder.write(bytes.subarray(4,11));decoder.write(bytes.subarray(11));
 assert.equal(draft,'中文第一行\n第二行');assert.equal(submitted,0);
 decoder.write(Buffer.from('\r\n'));assert.equal(submitted,1);
 decoder.write(Buffer.from('\u0003'));assert.equal(detached,1);
});

test('Ctrl-D inside an unfinished bracketed paste detaches without submitting its contents',()=>{
 let draft='',submitted=0,detached=0;
 const decoder=new AttachInputDecoder({onText:value=>{draft=value===null?draft.slice(0,-1):draft+value;},onSubmit:()=>submitted++,onDetach:()=>detached++});
 decoder.write(Buffer.from('\u001b[200~未完成\n粘贴\u0004不应继续'));
 assert.equal(draft,'未完成\n粘贴');assert.equal(submitted,0);assert.equal(detached,1);
});

test('number selection targets one node and multiline Chinese paste causes exactly one explicit send',async()=>{
 const h=harness(),ui=start(h);
 await until(()=>ui.output.value.includes('子工作节点'));
 assert(!ui.output.value.includes('工具事件完整参数'),'总览不应倾倒节点历史');
 ui.input.write('2\r');
 await until(()=>ui.output.value.includes('工具事件完整参数'));
 ui.input.write('\u001b[20');ui.input.write('0~第一行中文\n第二行中文\u001b[201~\r');
 await until(()=>h.sent.length===1);
 assert.deepEqual(h.sent[0],{assignmentId:'worker-child',text:'第一行中文\n第二行中文',operationId:'attach-send-test-1'});
 assert.equal(h.answered.length,0);
 ui.input.write('\u0003');assert.equal((await ui.result).status,'DETACHED');assert.equal(h.closed,1);
 assert.deepEqual(ui.input.raw,[true,false]);assert.match(ui.output.value,/工作线程未被中断/);
});

test('navigation, overview text, read-only input and detach never create sends or answers',async()=>{
 const decision={id:'business-1',kind:'BUSINESS',status:'OPEN',supported:true,question:'是否使用标记？',context:'隔离测试'};
 const snapshot=baseSnapshot();snapshot.decisions=[decision];
 const h=harness(snapshot,{[decision.id]:{decision}}),ui=start(h,{readOnly:true});
 await until(()=>ui.output.value.includes('任务总览'));
 for(const input of ['/help\r','/agents\r','总览普通文字\r','1\r','不应发送\r','/decision business-1\r','也不应答复\r','/back\r','/detach\r'])ui.input.write(input);
 const result=await ui.result;
 assert.equal(result.mode,'READ_ONLY');assert.equal(h.sent.length,0);assert.equal(h.answered.length,0);assert.equal(h.closed,1);
 assert.match(ui.output.value,/当前为只读 attach，不能发送消息/);assert.match(ui.output.value,/当前为只读 attach，不能回答决定/);
});

test('paused, closed or unknown targets reject input locally with the service reason',async()=>{
 const snapshot=baseSnapshot();
 snapshot.nodes=[
  {...snapshot.nodes[0],id:'paused-worker',title:'暂停节点',status:'PAUSED',canSend:false,reason:'任务已暂停'},
  {...snapshot.nodes[1],id:'closed-worker',parentAssignmentId:'paused-worker',title:'关闭节点',status:'closed',canSend:false,reason:'派工已关闭'},
 ];
 const h=harness(snapshot),ui=start(h);
 await until(()=>ui.output.value.includes('派工已关闭'));
 ui.input.write('/agent missing\r');ui.input.write('1\r暂停时不发送\r');ui.input.write('/agent closed-worker\r关闭后不发送\r');
 await until(()=>ui.output.value.includes('节点当前不可发送：派工已关闭'));
 assert.equal(h.sent.length,0);assert.match(ui.output.value,/未找到工作节点/);assert.match(ui.output.value,/节点当前不可发送：任务已暂停/);
 ui.input.write('/detach\r');await ui.result;
});

test('plain chat cannot approve; focused BUSINESS, INPUT and APPROVAL prompts preserve answer shapes',async()=>{
 const approval={id:'approval-1',kind:'APPROVAL',status:'OPEN',supported:true,question:'允许本次命令？',options:[{label:'accept',description:'仅本次'},{label:'decline',description:'拒绝'}]};
 const inputDecision={id:'input-1',kind:'INPUT',status:'OPEN',supported:true,question:'填写颜色和说明',questions:[{id:'color',header:'颜色',question:'选择颜色',options:[{label:'red',description:'红'},{label:'green',description:'绿'}]},{id:'note',header:'说明',question:'输入说明',options:[]}]};
 const business={id:'business-1',kind:'BUSINESS',status:'OPEN',supported:true,question:'业务选哪一个？',options:[{label:'甲',description:'方案甲'}]};
 const snapshot=baseSnapshot();snapshot.decisions=[approval,inputDecision,business];
 const details=Object.fromEntries(snapshot.decisions.map(decision=>[decision.id,{decision,...(decision.kind==='APPROVAL'?{runtime:{method:'item/commandExecution/requestApproval',command:'fixture only'}}:{})}]));
 const h=harness(snapshot,details),ui=start(h);
 await until(()=>ui.output.value.includes('/decision approval-1'));
 ui.input.write('1\raccept\r');
 await until(()=>h.sent.length===1);assert.equal(h.answered.length,0,'plain chat must not become an approval');
 ui.input.write('/decision approval-1\raccept\r');await until(()=>h.answered.length===1);
 ui.input.write('/decision input-1\r2\r第二项中文说明\r');await until(()=>h.answered.length===2);
 ui.input.write('/decision business-1\r明确选择甲\r');await until(()=>h.answered.length===3);
 assert.deepEqual(h.answered.map(x=>x.answer),[
  {decision:'accept'},
  {answers:{color:{answers:['green']},note:{answers:['第二项中文说明']}}},
  {text:'明确选择甲'},
 ]);
 assert(h.answered.every(x=>x.presentedEvidence.includes(x.decisionId)));
 assert.match(h.answered[0].presentedEvidence,/accept — 仅本次/);
 assert.match(h.answered[0].presentedEvidence,/原始请求核对[\s\S]*fixture only/);
 assert.match(ui.output.value,/原始请求核对/);
 ui.input.write('/detach\r');await ui.result;
});

test('stream refresh appends changed output while preserving an unfinished draft and target',async()=>{
 const h=harness(),ui=start(h,{pollIntervalMs:20});
 await until(()=>ui.output.value.includes('主工作节点'));
 assert(!ui.output.value.includes('已有完整输出'));
 ui.input.write('1\r');await until(()=>ui.output.value.includes('已有完整输出'));
 ui.input.write('前半段');
 const changed=h.snapshot;changed.nodes[0].messages[0].text='已有完整输出，现已增长';h.snapshot=changed;
 await until(()=>ui.output.value.includes('现已增长'));
 assert.match(ui.output.value,/主工作节点 > 前半段/);
 ui.input.write('后半段\r');await until(()=>h.sent.length===1);
 assert.equal(h.sent[0].text,'前半段后半段');assert.equal(h.sent[0].assignmentId,'worker-root');
 ui.input.write('\u0004');await ui.result;
});

test('overview suppresses node streams and revisiting a node emits only updates accumulated while away',async()=>{
 const h=harness(),ui=start(h,{pollIntervalMs:20});
 await until(()=>ui.output.value.includes('主工作节点'));
 assert(!ui.output.value.includes('已有完整输出'));
 ui.input.write('1\r');await until(()=>ui.output.value.includes('已有完整输出'));
 ui.input.write('/back\r');await until(()=>ui.output.value.includes('任务总览'));
 const changed=h.snapshot;changed.nodes[0].messages[0].text='离开期间的节点更新';h.snapshot=changed;
 await delay(80);assert(!ui.output.value.includes('离开期间的节点更新'));
 ui.input.write('/agent worker-root\r');await until(()=>ui.output.value.includes('离开期间的节点更新'));
 const once=(ui.output.value.match(/离开期间的节点更新/g)||[]).length;
 ui.input.write('/back\r/agent worker-root\r');await until(()=>ui.output.value.includes('— 无新增输出'));
 assert.equal((ui.output.value.match(/离开期间的节点更新/g)||[]).length,once);
 ui.input.write('/detach\r');await ui.result;
});

test('non-TTY mode is deterministic and can only take a read-only one-shot snapshot',async()=>{
 const snapshot=baseSnapshot(),h=harness(snapshot),output={isTTY:false,value:'',write(value){this.value+=value;}};
 const result=await runAttach('/fixture','task-a',{readOnly:true,input:{isTTY:false},output,openClient:async()=>h.client});
 assert.equal(result.mode,'READ_ONLY_SNAPSHOT');assert.equal(output.value,renderAttachSnapshot(snapshot,{includeMessages:false})+'\n');assert(!output.value.includes('已有完整输出'));assert.equal(h.closed,1);
 const blocked=harness(snapshot);
 await assert.rejects(runAttach('/fixture','task-a',{input:{isTTY:false},output,openClient:async()=>blocked.client}),/TASK_ATTACH_TTY_REQUIRED/);
 assert.equal(blocked.closed,1);
});

test('real PTY keeps Chinese multiline paste intact and Ctrl-D only detaches',async()=>{
 assert(process.env.REVIEW_TASK_DIR,'测试须经受管 process');
 const fixture=fileURLToPath(new URL('fixtures/task-attach-pty.mjs',import.meta.url));
 const python=String.raw`
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
p = subprocess.Popen([sys.argv[1], sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
data = b''
deadline = time.time() + 8
while b'PTY_READY' not in data and time.time() < deadline:
    ready, _, _ = select.select([master], [], [], .1)
    if ready:
        try: data += os.read(master, 65536)
        except OSError: break
os.write(master, b'1\r')
os.write(master, '\x1b[200~甲行\n乙行\x1b[201~\r'.encode('utf-8'))
time.sleep(.15)
os.write(master, b'\x04')
while time.time() < deadline:
    ready, _, _ = select.select([master], [], [], .1)
    if ready:
        try: data += os.read(master, 65536)
        except OSError: break
    if b'PTY_RESULT=' in data: break
    if p.poll() is not None: break
if b'PTY_RESULT=' in data:
    p.wait(timeout=2)
elif p.poll() is None:
    p.terminate()
    p.wait(timeout=2)
sys.stdout.buffer.write(data)
sys.exit(p.returncode)
`;
 const {stdout}=await exec('python3',['-c',python,process.execPath,fixture],{encoding:'utf8',timeout:12000,maxBuffer:1024*1024});
 const marker=stdout.match(/PTY_RESULT=(\{[^\r\n]+\})/);assert(marker,stdout);
 const result=JSON.parse(marker[1]);
 assert.deepEqual(result.sent,[{assignmentId:'pty-worker',text:'甲行\n乙行'}]);assert.equal(result.answers,0);assert.equal(result.closed,1);
 assert.match(stdout,/工作线程未被中断/);
});
