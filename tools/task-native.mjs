import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';

// Connect only to an existing Codex server. Never start a separate daemon,
// delete history, edit Codex's database, or infer closure from an idle turn.
export function connectNative({binary='codex',socket,timeoutMs=8000}={}) {
  const child=spawn(binary,['app-server','proxy',...(socket?['--sock',socket]:[])],{stdio:['pipe','pipe','pipe']});
  const pending=new Map();let counter=0,closed=false;
  child.stderr.resume();
  const rejectAll=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
  child.on('error',rejectAll);child.on('exit',()=>rejectAll(Error('原生 App Server 连接已结束')));
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{
    let message;try{message=JSON.parse(line);}catch{return;}
    const p=pending.get(message.id);if(!p)return;
    pending.delete(message.id);clearTimeout(p.timer);
    message.error?p.reject(Error(message.error.message||'原生 API 请求失败')):p.resolve(message.result);
  });
  const call=(method,params={})=>new Promise((resolve,reject)=>{
    if(closed)return reject(Error('原生连接已关闭'));
    const id=++counter,timer=setTimeout(()=>{pending.delete(id);reject(Error(`原生 API 超时：${method}`));},timeoutMs);
    pending.set(id,{resolve,reject,timer});
    child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});
  });
  return {call,async initialize(){await call('initialize',{clientInfo:{name:'review_tasks',version:'2'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');},close(){closed=true;rejectAll(Error('原生连接已关闭'));lines.close();child.stdin.end();child.kill();}};
}

async function loadedThreads(client) {
  const ids=[];let cursor;
  do {const page=await client.call('thread/loaded/list',{...(cursor?{cursor}:{}),limit:100});ids.push(...page.data);cursor=page.nextCursor;} while(cursor);
  return ids;
}
export async function assertNativeChild(client,threadId,parentThreadId) {
  if(!threadId||threadId===parentThreadId)throw Error('只能操作当前派工的独立子会话');
  const result=await client.call('thread/read',{threadId,includeTurns:false});
  if(result.thread.source?.subAgent?.thread_spawn?.parent_thread_id!==parentThreadId)throw Error('原生线程未被证实是当前主会话的子 Agent');
  return result.thread;
}
async function terminalsFor(client,threadId) {
  const result=[];let cursor;
  do {const page=await client.call('thread/backgroundTerminals/list',{threadId,limit:100,...(cursor?{cursor}:{})});result.push(...page.data);cursor=page.nextCursor;}while(cursor);
  return result;
}
export async function closeNativeThread(client,threadId,parentThreadId,{probe=false}={}) {
  if(!threadId||threadId===parentThreadId)throw Error('只能关闭当前派工的独立子会话');
  if(!probe)await assertNativeChild(client,threadId,parentThreadId);
  const goal=await client.call('thread/goal/get',{threadId});
  if(goal.goal && !['complete','paused'].includes(goal.goal.status)) await client.call('thread/goal/set',{threadId,status:'paused'});
  const current=await client.call('thread/read',{threadId,includeTurns:true});
  for(const turn of current.thread.turns||[]) if(turn.status==='inProgress') await client.call('turn/interrupt',{threadId,turnId:turn.id});
  for(const terminal of await terminalsFor(client,threadId)) {
    if(!terminal.processId)throw Error('原生后台命令身份未知，不能清理');
    await client.call('thread/backgroundTerminals/terminate',{threadId,processId:terminal.processId});
  }
  if((await terminalsFor(client,threadId)).length)throw Error('原生后台命令尚未确认结束');
  if((await loadedThreads(client)).includes(threadId))await client.call('thread/archive',{threadId});
  const loaded=await loadedThreads(client);
  const readback=await client.call('thread/read',{threadId,includeTurns:false});
  if(loaded.includes(threadId)||readback.thread.status?.type!=='notLoaded')throw Error('未确认原生会话卸载；不能将空闲或归档回执当作关闭');
  return {id:randomUUID(),nativeThreadId:threadId,verified:true,history:'PRESERVED',verifiedAt:new Date().toISOString()};
}

export async function probeNative({parentThreadId=process.env.CODEX_THREAD_ID,availableSlots=0,probeRoot,clientFactory=connectNative,...options}={}) {
  const base={checkedAt:new Date().toISOString(),parentThreadId:parentThreadId||null,delegation:false,closeVerified:false,goalVerified:false,availableSlots:0,models:[]};
  if(!parentThreadId||!probeRoot)return {...base,limitation:'缺少当前原生会话身份或受管探测目录，主 Agent 执行'};
  const client=clientFactory(options);let probeId;
  try {
    await client.initialize();
    const parent=await client.call('thread/read',{threadId:parentThreadId,includeTurns:false});
    if(parent.thread.id!==parentThreadId)throw Error('App Server 未映射当前主会话');
    const models=await client.call('model/list');
    base.models=models.data.map(m=>({model:m.model||m.id,efforts:m.supportedReasoningEfforts.map(e=>e.reasoningEffort)}));
    const probe=await client.call('thread/start',{cwd:probeRoot,ephemeral:false});probeId=probe.thread.id;
    const receipt=await closeNativeThread(client,probeId,parentThreadId,{probe:true});
    return {...base,delegation:true,closeVerified:true,availableSlots:Math.max(0,Math.min(32,availableSlots)),closureProbe:receipt,
      limitation:'原生关闭已核查；子 Goal 自动跨轮续行及父会话停止尚未实测，长派工使用 FOLLOWUP'};
  } catch(error) {return {...base,probeThreadId:probeId||null,limitation:error.message+'；主 Agent 串行执行'};}
  finally {client.close();}
}

// A native Goal is enabled only after a controlled child has demonstrated two
// distinct turns, unchanged parent Goal, and a successful parent pause/readback.
// The caller records this test in the current run; capability does not migrate.
export async function verifyGoalProbe(client,{childThreadId,parentThreadId,firstTurnId,timeoutMs=20000,pollMs=500}) {
  await assertNativeChild(client,childThreadId,parentThreadId);
  const goalShape=g=>g?{objective:g.objective,status:g.status,tokenBudget:g.tokenBudget}:null;
  const parentBefore=goalShape((await client.call('thread/goal/get',{threadId:parentThreadId})).goal);
  const first=await client.call('thread/read',{threadId:childThreadId,includeTurns:true});
  if(!firstTurnId||!first.thread.turns?.some(t=>t.id===firstTurnId))throw Error('缺少第一轮原生 Goal 探测执行');
  const seen=new Set(first.thread.turns.map(t=>t.id));
  const goal=await client.call('thread/goal/get',{threadId:childThreadId});
  if(goal.goal?.status!=='active')throw Error('隔离探测子 Goal 必须处于 active');
  let continued=false;
  try {
    const deadline=Date.now()+Math.min(timeoutMs,40000);
    while(Date.now()<deadline) {
      const current=await client.call('thread/read',{threadId:childThreadId,includeTurns:true});
      if(current.thread.turns.some(t=>!seen.has(t.id))){continued=true;break;}
      await new Promise(resolve=>setTimeout(resolve,pollMs));
    }
  } finally {await client.call('thread/goal/set',{threadId:childThreadId,status:'paused'});}
  const paused=await client.call('thread/goal/get',{threadId:childThreadId});
  const parentAfter=goalShape((await client.call('thread/goal/get',{threadId:parentThreadId})).goal);
  if(!continued)throw Error('未观察到无需 followup 的原生 Goal 自动跨轮续行');
  if(JSON.stringify(parentBefore)!==JSON.stringify(parentAfter))throw Error('父 Goal 已变化，不能确认隔离');
  if(paused.goal?.status!=='paused')throw Error('未验证父会话停止 Goal');
  return {goalVerified:true,verifiedAt:new Date().toISOString(),evidence:'独立 Goal、观察期间未发 turn/followup 而产生新轮次，父端暂停回读通过'};
}
