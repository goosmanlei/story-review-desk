import assert from 'node:assert/strict';
import {requiredPhase} from '../tools/process-resources.mjs';
import {database,closeDatabase} from '../server/db.mjs';
import {workOnce} from '../server/jobs.mjs';
assert.ok(await requiredPhase(process.cwd()),'Use managed runner');
const base=(process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913')+'/api/v1/';
async function get(path){const response=await fetch(base+path),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
const profile=await get('workspaces/profile');assert.match(profile.instanceId,/^ui-fixture-/);
async function post(path,body,key=crypto.randomUUID()){const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key,'X-Review-Runtime':profile.deployment.runtimeEpoch},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};}
const pool=await database();assert.equal((await pool.query('SELECT instance_id FROM project')).rows[0].instance_id,profile.instanceId);
try{
 const plan=(await get('workspaces/views/episode-plan')).plan,comments=await get('workspaces/script-comments?episodeUid='+plan.content.episodes[0].episodeUid),target=comments.targets.find(t=>t.kind==='EPISODE_DESIGN'),block=target.blocks.find(b=>b.text.length>=4);
 const before=await get('objects/'+encodeURIComponent(target.objectId));
 const input={snapshotId:comments.snapshotId,revisionId:plan.revisionId,target,anchor:{blockId:block.id,startOffset:0,endOffset:4,quote:block.text.slice(0,4)},commentDraft:'请将这条修改意见写得更明确。'};
 const route='workspaces/script-comments/polish',key='polish-fixture:'+crypto.randomUUID();
 let response=await post(route,input,key);assert.equal(response.status,202,JSON.stringify(response.value));assert.equal(response.value.operationId,key);
 assert.equal((await post(route,input,key)).value.replayed,true);
 assert.equal((await post(route,input)).status,409);
 assert.equal((await post(route,{...input,commentDraft:'另一条意见'},key)).status,409);
 let calls=0;
 await workOnce(pool,{root:process.env.REVIEW_INSTANCE_ROOT,workerId:'polish-simulation',providers:{suggest:async({request})=>{assert.equal(request.operationId,key);assert.ok(request.commentPolish.context.resources.length);calls++;return {summary:'模拟意见：请补充角色采取行动的明确依据。',patch:{text:'不应写入正文'},sourceVersions:[]};}}});
 assert.equal(calls,1);
 const result=await get(route+'?operationId='+encodeURIComponent(key));assert.equal(result.polishedComment,'模拟意见：请补充角色采取行动的明确依据。');
 assert.equal((await get('objects/'+encodeURIComponent(target.objectId))).version,before.version);
 const apply=await post('suggestions/'+encodeURIComponent(key)+'/apply',{operationId:crypto.randomUUID(),objectId:target.objectId,expectedVersion:before.version});assert.equal(apply.value.error?.code,'COMMENT_DRAFT_ONLY',JSON.stringify(apply));assert.equal(apply.value.status,'FAILED','A comment suggestion must never be applied to the reviewed episode');
 const wrong=await post(route,{...input,anchor:{...input.anchor,startOffset:1,endOffset:5}});assert.equal(wrong.status,409);
 await pool.query("UPDATE suggestions SET expires_at=now()-interval '1 second' WHERE operation_id=$1",[key]);
 assert.equal((await fetch(base+route+'?operationId='+encodeURIComponent(key))).status,410);
 console.log('PASS async comment polish, controlled provider, in-flight deduplication, exact anchor, body protection and 10-minute retention');
}finally{await closeDatabase();}
