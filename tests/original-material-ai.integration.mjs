import assert from 'node:assert/strict';
import {requiredPhase} from '../tools/process-resources.mjs';
import {database,closeDatabase} from '../server/db.mjs';
import {workOnce} from '../server/jobs.mjs';
assert.ok(await requiredPhase(process.cwd()));
const base=(process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913')+'/api/v1/';
async function get(p){const r=await fetch(base+p),v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v;}
const profile=await get('workspaces/profile');assert.match(profile.instanceId,/^ui-fixture-/);
async function post(p,b,key=crypto.randomUUID()){const r=await fetch(base+p,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key,'X-Review-Runtime':profile.deployment.runtimeEpoch},body:JSON.stringify(b)});return {status:r.status,value:await r.json()};}
const pool=await database();assert.equal((await pool.query('SELECT instance_id FROM project')).rows[0].instance_id,profile.instanceId);
try{
 const material=await get('workspaces/views/materials'),ops=await get('workspaces/operations/snapshot');
 const requirement=material.page.materialRequirements.find(r=>r.reviewSpec?.criteria?.length&&Object.values(ops.stateProjection.assetVersionsById).some(v=>r.assetFamilyRefs.includes(v.familyId)&&v.outputState==='PRESENT'&&v.mediaKind==='IMAGE'));
 const version=Object.values(ops.stateProjection.assetVersionsById).find(v=>requirement.assetFamilyRefs.includes(v.familyId)&&v.outputState==='PRESENT'&&v.mediaKind==='IMAGE');
 const before=await get('objects/'+encodeURIComponent(version.id));
 const input={snapshotId:ops.snapshotId,requirementId:requirement.id,reviewSpecHash:requirement.reviewSpec.hash,familyId:version.familyId,versionId:version.id,versionSha256:version.sha256,contextHash:version.reviewContextHash};
 const route='workspaces/material-review-drafts',key='material-sim:'+crypto.randomUUID();
 let response=await post(route,input,key);assert.equal(response.status,202,JSON.stringify(response));
 assert.equal((await post(route,input,key)).value.replayed,true);assert.equal((await post(route,input)).status,409);
 assert.equal((await post(route,{...input,versionSha256:'0'.repeat(64)},key)).status,409);
 let calls=0;await workOnce(pool,{root:process.env.REVIEW_INSTANCE_ROOT,workerId:'material-review-simulation',providers:{suggest:async({request})=>{calls++;assert.equal(request.operationId,key);return {summary:'模拟意见',patch:{materialReview:{summary:'模拟意见',overallNote:'模型没有读取原图',qualityRecommendation:'QUALITY_PASS_ON_OBSERVED_EVIDENCE',criterionFindings:requirement.reviewSpec.criteria.map(c=>({criterionId:c.id,verdict:'PASS',note:'模拟元数据推断'})),observations:['不能冒充看图'],unobserved:[]}},sourceVersions:[],observedImageIds:[]};}}});
 assert.equal(calls,1);const value=await get(route+'?operationId='+encodeURIComponent(key));assert.equal(value.draft.qualityRecommendation,'INSUFFICIENT_EVIDENCE');assert.ok(value.draft.criterionFindings.every(f=>f.verdict==='UNKNOWN'));assert.deepEqual(value.draft.observations,[]);
 const applied=await post('suggestions/'+encodeURIComponent(key)+'/apply',{operationId:crypto.randomUUID(),objectId:before.id,expectedVersion:before.version});assert.equal(applied.value.error?.code,'MATERIAL_DRAFT_ONLY',JSON.stringify(applied));
 assert.equal((await get('objects/'+encodeURIComponent(version.id))).version,before.version);
 await pool.query("UPDATE suggestions SET expires_at=now()-interval '1 second' WHERE operation_id=$1",[key]);assert.equal((await fetch(base+route+'?operationId='+encodeURIComponent(key))).status,410);
 console.log('PASS original material AI: queued operation, replay/conflict, controlled model, observations stay UNKNOWN without original reads, draft-only result, TTL');
}finally{await closeDatabase();}
