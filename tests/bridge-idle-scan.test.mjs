import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{createRequire}from'node:module';import{execFileSync}from'node:child_process';import{DatabaseSync}from'node:sqlite';
const root=process.cwd(),require=createRequire(path.join(root,'package.json')),ts=require('typescript');
const files=['host/codex_conversation_bridge.py','host/instance_aux.py','host/instance-runtime/index.mjs','host/instance-runtime/postgres.mjs'];
const source=Object.fromEntries(files.map(file=>[file,fs.readFileSync(path.join(root,file),'utf8')]));
function method(file,className,name,helpers){const ast=ts.createSourceFile(file,source[file],ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),type=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text===className),member=type.members.find(n=>n.name?.getText(ast)===name);return Function(...Object.keys(helpers),'return ({'+member.getText(ast)+'}).'+name)(...Object.values(helpers));}
const identity=x=>x;
test('listAux filters literal prefixes in SQL and preserves latest heads, order, deleted opt-in and no-prefix contract',async()=>{
 const db=new DatabaseSync(':memory:');try{db.exec('CREATE TABLE record_revisions(revision_id TEXT PRIMARY KEY,namespace TEXT,record_key TEXT,deleted INTEGER,content_bytes BLOB);CREATE TABLE record_heads(namespace TEXT,record_key TEXT,revision_id TEXT,PRIMARY KEY(namespace,record_key));');db.function('starts_with',(text,prefix)=>text.startsWith(prefix)?1:0);
 const put=(key,revision,deleted=0)=>{db.prepare('INSERT INTO record_revisions VALUES(?,?,?,?,?)').run(revision,'aux:assistant-public',key,deleted,Buffer.from('payload:'+revision));db.prepare('INSERT INTO record_heads VALUES(?,?,?) ON CONFLICT(namespace,record_key) DO UPDATE SET revision_id=excluded.revision_id').run('aux:assistant-public',key,revision);};
 for(const [i,key]of['turns/a.json','turns/Z.json','turns/%_\\甲.json','turns/%_\\甲乙.json','turns/%x.json','Turns/upper.json','unrelated/large.json','turns/deleted.json'].entries())put(key,'r'+i,key.includes('deleted')?1:0);put('turns/a.json','new-head');db.prepare('INSERT INTO record_revisions VALUES(?,?,?,?,?)').run('other','aux:other','turns/a.json',0,Buffer.from('other'));db.prepare('INSERT INTO record_heads VALUES(?,?,?)').run('aux:other','turns/a.json','other');
 const fetched=[];const sqlite=method('host/instance-runtime/index.mjs','ReadUnit','listAux',{text:identity,record:identity}),postgres=method('host/instance-runtime/postgres.mjs','PgUnit','listAux',{text:identity,rowRecord:identity});
 const sqliteUnit={db:{prepare:sql=>({all:(...args)=>{const rows=db.prepare(sql).all(...args);fetched.push({sql,args,count:rows.length});return rows;}})}};
 const pgUnit={all:async(sql,args)=>{const rows=db.prepare(sql.replaceAll('$1','?').replaceAll('$2','?')).all(...args);fetched.push({sql,args,count:rows.length});return rows;}};
 for(const prefix of['','turns/','turns/%_\\','turns/%x','turns/Z','Turns/','不存在/'])for(const includeDeleted of[false,true]){const options={prefix,includeDeleted};const left=sqlite.call(sqliteUnit,'assistant-public',options),right=await postgres.call(pgUnit,'assistant-public',options);assert.deepEqual(left,right);const expected=db.prepare('SELECT r.* FROM record_heads h JOIN record_revisions r ON r.revision_id=h.revision_id WHERE h.namespace=? ORDER BY h.record_key').all('aux:assistant-public').filter(r=>r.record_key.startsWith(prefix)&&(includeDeleted||!r.deleted));assert.deepEqual(left,expected);if(prefix==='turns/%_\\')assert.equal(fetched.at(-1).count,2,'SQL must not fetch unrelated namespace bodies');}
 assert.deepEqual(sqlite.call(sqliteUnit,'assistant-public'),await postgres.call(pgUnit,'assistant-public'));assert.equal(sqlite.call(sqliteUnit,'assistant-public',{prefix:'turns/a'})[0].revision_id,'new-head');assert.ok(fetched.every(q=>!q.sql.includes('LIKE')));
 }finally{db.close();}
});
const python=String.raw`
import asyncio,base64,datetime,hashlib,json,sys,types
from pathlib import Path
v=json.load(sys.stdin);root=Path(v['root']);sys.path.insert(0,str(root/'host'))
def module(name,file):
 m=types.ModuleType(name);m.__file__=str(root/file);sys.modules[name]=m;exec(compile(v['source'][file],m.__file__,'exec'),m.__dict__);return m
aux=module('instance_aux','host/instance_aux.py');bridge=module('bridge_idle_test','host/codex_conversation_bridge.py')
clock=[0.0];calls=[];rows={};health=[];serial=[0];race=[None]
store=aux.InstanceStorage.__new__(aux.InstanceStorage);store.root=Path('/synthetic');store.public_root=store.root/'runtime/assistant/public';store.private_root=store.root/'runtime/assistant/private';store.runtime_epoch='epoch-current';store.execution_protocol=bridge.EXECUTION_PROTOCOL
def add(key,value,epoch='epoch-current',deleted=False):
 serial[0]+=1;b=json.dumps(value,ensure_ascii=False).encode();r={'key':key,'revisionId':'head-'+str(serial[0]),'revision':serial[0],'bytesBase64':base64.b64encode(b).decode(),'sha256':hashlib.sha256(b).hexdigest(),'deleted':deleted,'metadata':{'runtimeEpoch':epoch},'mediaType':'application/json','createdAt':'fixture'};rows[key]=r;return r
def command(name,flags,*args,**kwargs):
 clock[0]+=.2;calls.append((name,list(flags)));f=dict(zip(flags[::2],flags[1::2]));assert f['--namespace']=='assistant-public','No private queue data allowed'
 if name=='aux-list':
  selected=[r.copy() for k,r in sorted(rows.items()) if k.startswith(f.get('--prefix','')) and not r['deleted']]
  return [{'key':r['key'],'revisionId':r['revisionId']} for r in selected] if f.get('--keys-only')=='true' else selected
 assert name=='aux-get','No write/model transport allowed';key=f['--key'];r=rows.get(key)
 if race[0] and key==race[0][0]:
  race[0][1]-=1
  if race[0][1]==0:
   r=add(key,json.loads(base64.b64decode(r['bytesBase64'])));race[0]=None
 return r.copy() if r else None
store._command=command;aux.INSTANCE=store;bridge.INSTANCE=store
worker=bridge.BridgeWorker.__new__(bridge.BridgeWorker);worker.project_root=store.root;worker.paths={'root':store.public_root,**{key:store.public_root/key for key in ['turns','results','claims','conversations']},'health':store.public_root/'health.json'};worker._validated_terminal_heads={};worker.policy_hash='a'*64;worker.mock_response='offline-fixture';worker.sdk_version='mock';worker.runtime_version='mock';worker.model='mock';worker.work_context_preflight_verified=True;worker.private_state_root=store.private_root
bridge.scheduler_private_paths=lambda root:{'root':root/'scheduler','slots':root/'scheduler/slots'}
scheduler=bridge.CodexBridgeScheduler(worker,max_concurrent=5,idle_ttl_seconds=600)
bridge.utc_now=lambda:datetime.datetime.fromtimestamp(1000000+clock[0],datetime.timezone.utc).isoformat()
def write_health(path,payload):
 assert path==worker.paths['health'];clock[0]+=.4;health.append({'payload':payload,'storedAt':clock[0]})
bridge.atomic_write_json=write_health
def turn(index):
 return {'schemaVersion':'1.0','turnId':'turn_'+format(index,'032x'),'conversationId':'codx_'+format(index,'032x'),'projectId':bridge.TRUSTED_PROJECT_ID,'snapshotId':'snapshot-fixture','sequence':1,'previousTurnHeadHash':'b'*64,'capabilityProfile':'READ_ONLY_ADVICE','userMessage':'readonly fixture','requestHash':'c'*64,'idempotencyKeyHash':'d'*64,'queuedAt':'fixture','schedulerProtocol':bridge.SCHEDULER_PROTOCOL}
def completed(t):return bridge.terminal_result(t,state='SUCCEEDED',context_manifest_hash='e'*64,policy='f'*64,answer='exact public terminal')
turns=[turn(i) for i in range(8)]
for t in turns:add('turns/'+t['turnId']+'.json',t);add('results/'+t['turnId']+'.json',completed(t))
async def scan_cycle():await scheduler.dispatch_available();scheduler.write_health()
asyncio.run(scan_cycle()) # Validate each exact historical result once.
calls.clear();clock[0]=0;health.clear();asyncio.run(scan_cycle())
at=health[-1];checked=datetime.datetime.fromisoformat(at['payload']['checkedAt']).timestamp()-1000000
normal={'transportCalls':len(calls),'simulatedCycleSeconds':clock[0],'persistedTimestampAgeSeconds':at['storedAt']-checked,'bodyReads':sum(name=='aux-get' for name,_ in calls),'queued':at['payload']['queuedTurnCount']}
print(json.dumps({'normal':normal}),flush=True)
assert normal['transportCalls']<=12 and normal['bodyReads']==0,'Completed history must not be reread per scan'
assert normal['persistedTimestampAgeSeconds']<.5,'checkedAt must follow queue counting'
assert at['payload']['status']=='READY' and normal['queued']==0
# A valid exact result is cached only while both immutable heads still match.
t=turns[0];key='results/'+t['turnId']+'.json';bad=completed(t);bad['state']='RUNNING';add(key,bad)
assert worker.paths['turns']/(t['turnId']+'.json') in worker.uncompleted_turn_paths()
assert worker.paths['turns']/(t['turnId']+'.json') not in list(worker.pending_turn_paths()),'An existing invalid result must never be dispatched again'
bad=completed(turns[1]);add(key,bad);assert worker.paths['turns']/(t['turnId']+'.json') in worker.uncompleted_turn_paths(),'Same filename cannot hide a cross-turn result'
add(key,completed(t),deleted=True);assert worker.paths['turns']/(t['turnId']+'.json') in worker.uncompleted_turn_paths()
add(key,completed(t));race[0]=[key,2];assert worker.paths['turns']/(t['turnId']+'.json') in worker.uncompleted_turn_paths(),'Head changed during validation must not be cached'
assert worker.uncompleted_turn_paths()==[]
changed={**t,'userMessage':'same identity but changed request body'};add('turns/'+t['turnId']+'.json',changed)
assert worker.paths['turns']/(t['turnId']+'.json') in worker.uncompleted_turn_paths(),'A new request head must match the terminal input hash, not just IDs'
add('turns/'+t['turnId']+'.json',t);assert worker.uncompleted_turn_paths()==[]
# Pending and claimed turns are never dispatched from a historical-completion cache.
pending=turn(99);add('turns/'+pending['turnId']+'.json',pending);pending_path=worker.paths['turns']/(pending['turnId']+'.json');assert pending_path in list(worker.pending_turn_paths())
add('claims/'+pending['turnId']+'.json',{'leaseId':'existing-live-lease'});assert pending_path not in list(worker.pending_turn_paths())
rows['claims/'+pending['turnId']+'.json']['deleted']=True;assert pending_path in list(worker.pending_turn_paths())
rows['turns/'+pending['turnId']+'.json']['metadata']['runtimeEpoch']='old-epoch';assert pending_path not in list(worker.pending_turn_paths())
# Malformed old-epoch terminal remains in the epoch reconciliation path; no overwrite/retry.
old=turn(100);add('turns/'+old['turnId']+'.json',old,epoch='old-epoch');add('results/'+old['turnId']+'.json',{'state':'SUCCEEDED'})
attempts=[];bridge.exclusive_json_create=lambda p,r:attempts.append((p,r)) or False
worker.reconcile_runtime_epoch_turns();assert any(r['turnId']==old['turnId'] for p,r in attempts)
assert all(r['state']=='RESULT_UNKNOWN' for p,r in attempts)
# Filesystem fixture pending discovery remains compatible and does no instance query.
bridge.INSTANCE=None;fake=Path('/fixture/turns/turn_00000000.json');bridge.path_glob=lambda d,p:[fake] if d==worker.paths['turns'] else [];bridge.path_exists=lambda p:False;assert list(worker.pending_turn_paths())==[fake]
bridge.path_exists=lambda p:p.parent==worker.paths['results'];assert list(worker.pending_turn_paths())==[]
print(json.dumps({'terminalRevisionCache':True,'invalidOrMismatchedResultNotSkipped':True,'headRaceRevalidated':True,'pendingClaimEpochGuards':True,'filesystemFallback':True,'formalWrites':0,'modelCalls':0}))
`;
test('real scheduler avoids repeated terminal reads, timestamps after queue I/O, and keeps terminal/claim/epoch fences',()=>{
 const output=execFileSync('python3',['-B','-c',python],{encoding:'utf8',input:JSON.stringify({root,source}),env:{PATH:process.env.PATH,LANG:'en_US.UTF-8'},timeout:20000});console.log(output.trim());assert.match(output,/'?"modelCalls": 0/);
});
