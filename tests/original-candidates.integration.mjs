import assert from 'node:assert/strict';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()),'Use managed runner');
const base=(process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913')+'/api/v1/';
async function get(p){const r=await fetch(base+p),v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v;}
const profile=await get('workspaces/profile');assert.match(profile.instanceId,/^ui-fixture-/);
const catalog=(await get('workspaces/views/material-catalog')).page;
const retained=catalog.materialRequirements.filter(r=>r.requirementClass==='OPTIONAL');assert(retained.length,'Fixture needs retained candidates');
let candidate,requirement,versions=0;
for(const row of retained){
 const page=(await get('workspaces/views/materials?requirementId='+encodeURIComponent(row.id))).page;
 const q=page.materialRequirements.find(r=>r.id===row.id);assert.match(q.reviewSpec.hash,/^[a-f0-9]{64}$/);
 assert(!q.coverageSatisfied,'An optional candidate does not satisfy an unrelated required item');
 for(const v of page.assetVersions){
  assert(v.revisionId&&v.objectVersion&&v.sha256&&v.mediaUrl);assert(q.assetFamilyRefs.includes(v.familyId));
  const bytes=await fetch(base+'media/'+v.sha256,{headers:{Range:'bytes=0-15'}});assert([200,206].includes(bytes.status));await bytes.arrayBuffer();versions++;
  if(!candidate&&v.lifecycleState==='REVIEW_PENDING'){candidate=v;requirement=q;}
 }
}
assert(candidate,'Fixture needs an unreviewed retained version');
const before=await get('objects/'+encodeURIComponent(candidate.id));
const input={subjectType:'ASSET',subjectId:candidate.familyId,familyId:candidate.familyId,versionId:candidate.id,versionSha256:candidate.sha256,objectRevisionId:candidate.revisionId,expectedVersion:candidate.objectVersion,requirementId:requirement.id,requirementRevisionId:requirement.revisionId,requirementVersion:requirement.objectVersion,reviewSpecHash:requirement.reviewSpec.hash,action:'REQUEST_REVISION',criterionFindings:requirement.reviewSpec.criteria.map(c=>({criterionId:c.id,verdict:'FAIL',note:'仅隔离接口验收'})),note:'仅隔离候选统一审阅核验'};
async function post(body,key=crypto.randomUUID()){const r=await fetch(base+'workspaces/reviews',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Runtime':profile.deployment.runtimeEpoch,'Idempotency-Key':key},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};}
assert.equal((await post({...input,versionSha256:'0'.repeat(64)})).status,409);
const key=crypto.randomUUID(),result=await post(input,key);assert.equal(result.status,200,JSON.stringify(result.value));
assert.deepEqual(await post(input,key),result);assert.equal((await post({...input,note:'Different request'},key)).status,409);assert.equal((await post(input)).status,409);
const after=await get('objects/'+encodeURIComponent(candidate.id));assert.equal(after.state,'CHANGES_REQUESTED');assert.equal(after.revision.id,before.revision.id);assert.equal(after.adoptedRevisionId,before.adoptedRevisionId);assert.equal(after.reviews.length,before.reviews.length+1);
console.log(JSON.stringify({status:'PASS',requirements:retained.length,versions,checks:['native catalogue','exact SHA','original review standard','shared review API','CAS and replay','adoption unchanged'],modelCalls:0}));
