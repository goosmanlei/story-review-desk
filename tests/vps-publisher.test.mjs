import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {Readable} from 'node:stream';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {emptyVpsState,executeVps,planVps} from '../host/instance-runtime/vps-journal.mjs';
import {validateVpsTarget} from '../host/instance-runtime/vps-target.mjs';
import {nginxManagedBlock,patchNginxConfig,applyNginxConfigInPlace,nginxSha} from '../host/instance-runtime/vps-nginx.mjs';
import {openRepeatableArchive,ExactStreamInput} from '../host/instance-runtime/archive-repeatable-stream.mjs';
import {WireInput} from '../host/instance-runtime/vps-wire.mjs';
import {hashArchiveRows,ARCHIVE_FILE_FORMAT} from '../host/instance-runtime/archive-file.mjs';
import {main} from '../scripts/instance-vps.mjs';
import {VpsDriver} from '../host/instance-runtime/vps-driver.mjs';
const target=validateVpsTarget({schemaVersion:'1.0',kind:'REVIEW_VPS_TARGET',targetId:'fixture',sshHost:'fixture-only',publicUrl:'https://review.example.invalid/story/',basePath:'/story',hostRoot:'/home/work/review/fixture',nginx:{container:'fixture-nginx',configPath:'/home/work/nginx/default.conf',network:'fixture-ingress',serverName:'review.example.invalid',authBasicRealm:'private',authBasicUserFile:'/etc/nginx/users'},runtime:{architecture:'linux/amd64',dockerBinary:'/usr/bin/docker',bashBinary:'/bin/bash',nodeBinary:'/usr/local/bin/node',codexBinary:'/usr/local/bin/codex',pythonBinary:'/usr/bin/python3',uvBinary:'/usr/local/bin/uv'},credentials:{codexHome:'/home/work/private/codex',providerKeyFile:'/home/work/private/provider-key'},retention:{cleanPackages:2,maxTemporaryBytes:1024,reserveBytes:8192},capacity:{recommendedVcpu:4,recommendedMemoryBytes:8*1024**3,recommendedDiskBytes:120*1024**3}});
function source(letter){return {manifest:{releaseId:'release_'+letter,manifestSha256:letter.repeat(64),softwareCommit:'a'.repeat(40),images:[{loadedBytes:100}],totalFileBytes:200,runtimeBudgetBytes:400},baseline:letter};}
function fixtureDriver(state){
 const copies=new Map(),events=[],runtimes=new Map();let serial=0;
 return {copies,events,runtimes,freeBytes:1e9,fail:null,busy:false,
  async save(s){this.saved=structuredClone(s);},async measure(){return {freeBytes:this.freeBytes,fullCopies:copies.size+runtimes.size};},async inspect(){return {freeBytes:this.freeBytes};},async validatePrepared(){},async verifySource(s){if(s.corrupt)throw Error('bad package');events.push('verify:'+s.baseline);},async cleanSource(r){const s=copies.get(r.slot);assert(s);return s;},
  async maintenance(){events.push('maintenance');},async drain(){if(this.busy)throw Error('workers busy');},async assertQuiescent(){if(this.busy)throw Error('workers busy');},
  async runtimeIntent(m){return {id:'owned-'+(++serial),releaseId:m.releaseId};},
  async restore(s,r){if(this.fail==='restore')throw Error('injected restore failure');r.runtimeEpoch=randomUUID();r.bytes=s.baseline;runtimes.set(r.id,r);events.push('restore:'+s.baseline);assert(copies.size+runtimes.size<=3);},async verifyRuntime(){if(this.fail==='verify')throw Error('verify failed');},async open(){events.push('open');},
  async removeRuntime(r){runtimes.delete(r.id);events.push('remove-runtime');},async removeClean(r){copies.delete(r.slot);events.push('remove-clean:'+r.releaseId);},async saveClean(s,r){if(this.fail==='save')throw Error('SSH interrupted saving');copies.set(r.slot,s);events.push('save:'+s.baseline);assert(copies.size+runtimes.size<=3);},
 };
}
const args=(state,driver,s,expected,action='deploy')=>({target,state,driver,source:s,expectedCurrent:expected,operationId:action+'_'+s.manifest.releaseId+'_'+expected,action});
test('verified VPS storage owner can be consumed by the Codex instance loader',async t=>{
 await mkdir('tests/.test-tmp',{recursive:true});const root=await mkdtemp(path.resolve('tests/.test-tmp/vps-owner-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'runtime'));await writeFile(path.join(root,'instance.json'),JSON.stringify({database:{kind:'postgres'}}));
 const runtime={root,runtimeEpoch:'epoch',instanceId:'fixture',appImage:'app',softwareCommit:'a'.repeat(40)},manifest={business:{sourceReleaseId:'release'},images:[{role:'app',reference:'app',id:'digest'}]},web={Id:'container',Image:'digest',Config:{Image:'app'},HostConfig:{PortBindings:{}},NetworkSettings:{Networks:{[target.nginx.network]:{}}}};
 const driver=new VpsDriver(target,emptyVpsState(target));driver.runtimeCheck=async()=>({metadata:{runtimeEpoch:'epoch',instanceId:'fixture',releaseId:'release'},integrity:{ok:true}});driver.owned=async()=>web;driver.object=async()=>({Id:'digest'});driver.docker=async()=>JSON.stringify({runtimeEpoch:'epoch',basePath:target.basePath});
 await driver.verifyRuntime(runtime,manifest);const owner=JSON.parse(await readFile(path.join(root,'runtime/storage-owner.json')));assert.equal(owner.composeProject,'review-vps-'+target.targetId);assert.match(owner.composeProject,/^review-[a-z0-9_-]+$/);
});
test('A -> B -> C discards writable edits, retains only B/C; rollback restores clean B under a new epoch',async()=>{
 const state=emptyVpsState(target),driver=fixtureDriver(state),a=source('A'),b=source('B'),c=source('C');
 await executeVps(args(state,driver,a,'NONE'));state.current.runtime.bytes='remote edit A';
 await executeVps(args(state,driver,b,a.manifest.releaseId));state.current.runtime.bytes='remote edit B';
 await executeVps(args(state,driver,c,b.manifest.releaseId));const epoch=state.current.runtime.runtimeEpoch;
 assert.equal(state.backup.releaseId,b.manifest.releaseId);assert.equal(state.current.runtime.bytes,'C');assert.equal(driver.copies.size,2);assert.equal(driver.runtimes.size,1);assert(driver.events.includes('remove-clean:release_A'));
 const receipt=await executeVps(args(state,driver,b,c.manifest.releaseId,'rollback'));
 assert.equal(receipt.status,'ROLLED_BACK_CLEAN');assert.equal(state.current.runtime.bytes,'B');assert.notEqual(state.current.runtime.runtimeEpoch,epoch);assert.equal(state.backup.releaseId,c.manifest.releaseId);assert.equal(driver.copies.size+driver.runtimes.size,3);
});
test('interrupted save retains online runtime/backup, blocks a new operation, resumes and replays exact receipt',async()=>{
 const state=emptyVpsState(target),driver=fixtureDriver(state),a=source('A'),b=source('B');await executeVps(args(state,driver,a,'NONE'));
 driver.fail='save';const request=args(state,driver,b,a.manifest.releaseId);await assert.rejects(executeVps(request),/SSH/);
 assert.equal(state.pending.phase,'SAVING');assert.equal(state.current.runtime.bytes,'B');assert.equal(state.backup.releaseId,a.manifest.releaseId);
 await assert.rejects(executeVps(args(state,driver,source('C'),b.manifest.releaseId)),/unfinished/);
 driver.fail=null;await executeVps(request);assert.equal((await executeVps(request)).replayed,true);assert.equal(state.pending,null);
});
test('corrupt inputs, insufficient space, version mismatch and active workers fail before runtime reclamation',async()=>{
 for(const failure of ['space','corrupt','cas','busy']){
  const state=emptyVpsState(target),driver=fixtureDriver(state),a=source('A'),b=source('B');await executeVps(args(state,driver,a,'NONE'));driver.events.length=0;
  if(failure==='space')driver.freeBytes=1;if(failure==='corrupt')b.corrupt=true;if(failure==='busy')driver.busy=true;
  await assert.rejects(executeVps(args(state,driver,b,failure==='cas'?'other':a.manifest.releaseId)));
  assert(!driver.events.includes('remove-runtime'));assert.equal(driver.runtimes.size,1);
 }
});
test('failed restore can recover only the clean current source, not writable edits',async()=>{
 const state=emptyVpsState(target),driver=fixtureDriver(state),a=source('A'),b=source('B');await executeVps(args(state,driver,a,'NONE'));state.current.runtime.bytes='remote dirt';
 driver.fail='restore';const request=args(state,driver,b,a.manifest.releaseId);await assert.rejects(executeVps(request));driver.fail=null;
 const receipt=await executeVps({...request,recover:true});assert.equal(receipt.status,'CLEAN_CURRENT_RECOVERED');assert.equal(state.current.runtime.bytes,'A');
});
test('target rejects broad paths, credentials, URL mismatch and injected binary/config values',()=>{
 for(const mutate of [v=>v.hostRoot='/home/work',v=>v.hostRoot='/home/work/../fixture',v=>v.runtime.nodeBinary='/usr/bin/node;id',v=>v.credentials.apiKey='secret',v=>v.publicUrl='https://review.example.invalid/wrong',v=>v.nginx.authBasicRealm='x"; return 200;']){const value=structuredClone(target);mutate(value);assert.throws(()=>validateVpsTarget(value));}
 const p=planVps(target,emptyVpsState(target),source('A').manifest,{freeBytes:1e9});assert.equal(p.maximumFullCopies,3);assert(p.requiredFreeBytes>p.packageBytes+p.runtimeBudgetBytes+p.loadedImageBytes);
});
const original='server {\n    listen 80;\n    server_name review.example.invalid;\n    return 301 https://$host$request_uri;\n}\nserver {\n    listen 443 ssl;\n    server_name review.example.invalid;\n    location /other/ { return 200 "untouched"; }\n}\n';
test('public demo requires explicit target policy and strips caller authentication claims',()=>{
 assert.equal(target.accessMode,'BASIC_AUTH');
 assert.throws(()=>validateVpsTarget({...target,accessMode:'OFF'}),/accessMode/);
 const demo=validateVpsTarget({...target,accessMode:'PUBLIC_DEMO'}),block=nginxManagedBlock(demo,{upstream:'172.20.0.2:3000'});
 assert.match(block,/auth_basic off;/);assert.doesNotMatch(block,/auth_basic_user_file|\$remote_user/);
 assert.match(block,/X-Review-Access-Mode PUBLIC_DEMO;/);assert.match(block,/X-Review-Authenticated-User "";/);
 assert.match(block,/X-Review-Internal-Gateway "";/);assert.match(block,/Authorization "";/);
 assert.equal(patchNginxConfig(original,demo,{upstream:'172.20.0.2:3000'}).contents.replace(block,''),original);
 assert.match(nginxManagedBlock(demo,{maintenance:true}),/auth_basic off;/);
});
test('Nginx patch preserves other bytes, targets HTTPS, authenticates maintenance and is idempotent',()=>{
 const a=patchNginxConfig(original,target,{upstream:'172.20.0.2:3000'});assert.equal(a.contents.replace(nginxManagedBlock(target,{upstream:'172.20.0.2:3000'}),''),original);
 assert.equal(patchNginxConfig(a.contents,target,{upstream:'172.20.0.2:3000'}).changed,false);assert.match(a.contents,/proxy_set_header X-Review-Authenticated-User \$remote_user/);
 const m=patchNginxConfig(a.contents,target,{maintenance:true});assert.match(m.contents,/error_page 502 504 =503/);assert(!m.contents.match(/location \^~ \/story\/ \{[^}]*return 503/));
 assert.throws(()=>patchNginxConfig(original.replace('listen 443 ssl','listen 443'),target,{maintenance:true}),/HTTPS/);
});
test('Nginx validation failure restores original bytes, mounted inode and reload',async t=>{
 await mkdir('tests/.test-tmp',{recursive:true});const root=await mkdtemp(path.resolve('tests/.test-tmp/vps-nginx-'));t.after(()=>rm(root,{recursive:true,force:true}));const filename=path.join(root,'default.conf');await writeFile(filename,original);const inode=(await stat(filename)).ino;let calls=0,reloads=0;
 await assert.rejects(applyNginxConfigInPlace(filename,target,{maintenance:true,expectedSha256:nginxSha(original),readBack:()=>readFile(filename),validate:async()=>{if(++calls===1)throw Error('nginx -t failed');},reload:async()=>{reloads++;}}),/nginx -t/);
 assert.equal(await readFile(filename,'utf8'),original);assert.equal((await stat(filename)).ino,inode);assert.equal(reloads,1);
});
test('HTTPS IP root target keeps ACME and redirect server separate and authenticates every app route',()=>{
 const root=validateVpsTarget({...target,basePath:'',publicUrl:'https://203.0.113.10/',nginx:{...target.nginx,serverName:'203.0.113.10'}});
 const config='server {\n listen 80;\n server_name 203.0.113.10;\n location ^~ /.well-known/acme-challenge/ { root /acme; }\n location / { return 308 https://203.0.113.10$request_uri; }\n}\nserver {\n listen 443 ssl;\n server_name 203.0.113.10;\n}\n';
 const applied=patchNginxConfig(config,root,{upstream:'172.20.0.2:3000'});
 const block=nginxManagedBlock(root,{upstream:'172.20.0.2:3000'});
 assert.equal(applied.contents.replace(block,''),config);assert.match(block,/location \^~ \/ \{/);assert.doesNotMatch(block,/location =/);
 assert.match(block,/auth_basic "private"/);assert.match(block,/proxy_set_header X-Forwarded-Host 203\.0\.113\.10/);
 assert.equal(patchNginxConfig(applied.contents,root,{upstream:'172.20.0.2:3000'}).changed,false);
 assert.throws(()=>patchNginxConfig(config.replace('listen 443 ssl;','listen 443 ssl;\n location / { return 200; }'),root,{maintenance:true}),/Unmanaged/);
 assert.throws(()=>validateVpsTarget({...root,publicUrl:'http://203.0.113.10/'}),/HTTPS/);
});
async function archive(){const header={instanceId:'fixture',schemaVersion:1},tableNames=['a','empty','z'],tables={a:[{id:'中文',bytes:'frozen'}],empty:[],z:[{id:'last'}]};const hash=await hashArchiveRows(header,tableNames,async function*(t){yield*tables[t];});const lines=[{format:ARCHIVE_FILE_FORMAT,header:{...header,exportSha256:hash.exportSha256},tableNames},...tableNames.flatMap(table=>tables[table].map(row=>({table,row}))),{end:true,rows:2}];const bytes=Buffer.from(lines.map(JSON.stringify).join('\n')+'\n');return {bytes,binding:{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},hash};}
test('repeatable stream checks every pass without a scratch file and survives arbitrary framing',async()=>{
 const f=await archive();let opens=0;const reader=await openRepeatableArchive(async function*(){opens++;for(let i=0;i<f.bytes.length;i+=7)yield f.bytes.subarray(i,i+7);},f.binding);
 const {exportSha256,...header}=reader.header;
 for(let pass=0;pass<3;pass++){const actual=await hashArchiveRows(header,reader.tableNames,t=>reader.iterate(t));assert.equal(actual.exportSha256,f.hash.exportSha256);await reader.assertUnchanged();}
 assert.equal(opens,4);assert.equal(reader.passes,4);await reader.close();
 const input=new ExactStreamInput(Readable.from([Buffer.concat([f.bytes,f.bytes])])),a=[];for await(const b of input.take(f.bytes.length))a.push(b);const b=[];for await(const c of input.take(f.bytes.length))b.push(c);assert.deepEqual(Buffer.concat(a),Buffer.concat(b));
});
test('changed or interrupted repeated stream fails closed before pass completion',async()=>{
 const f=await archive();let calls=0;const reader=await openRepeatableArchive(async function*(){calls++;yield calls===1?f.bytes:Buffer.from(f.bytes.toString().replace('frozen','edited'));},f.binding);
 const {exportSha256,...header}=reader.header;
 await assert.rejects(hashArchiveRows(header,reader.tableNames,t=>reader.iterate(t)),/SHA/);await assert.rejects(reader.assertUnchanged());await reader.close();
 await assert.rejects(openRepeatableArchive(async function*(){yield f.bytes.subarray(0,-3);},f.binding),/Truncated/);
});
test('wire protocol has bounded control records and keeps binary read-ahead exact',async()=>{
 const bytes=Buffer.from([0,255,10,128]),input=new WireInput(Readable.from([Buffer.concat([Buffer.from('{"ok":true}\n'),bytes,Buffer.from('{"end":true}\n')])]));assert.deepEqual(await input.json(),{ok:true});let result=[];for await(const c of input.take(4))result.push(c);assert.deepEqual(Buffer.concat(result),bytes);assert.deepEqual(await input.json(),{end:true});
 await assert.rejects(new WireInput(Readable.from(['{"tooLong":true}\n'])).json(2),/bound/);
});
