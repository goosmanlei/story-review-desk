import assert from 'node:assert/strict';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()),'Use managed runner');
const base=(process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913')+'/api/v1/';
async function get(p){const r=await fetch(base+p),v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v;}
const profile=await get('workspaces/profile');assert.match(profile.instanceId,/^ui-fixture-/);
const index=await get('workspaces/candidates/scopes');assert.equal(index.scopes.length,2);
const snapshots=await Promise.all(index.scopes.map(s=>get('workspaces/candidates/snapshot?scopeId='+s.id)));
assert.equal(snapshots.reduce((n,s)=>n+s.assets.length,0),20);
for(const snapshot of snapshots){assert.equal(snapshot.scope.countsTowardFormalProject,false);assert.equal(snapshot.checkpoint.executionAuthorized,false);assert.ok(snapshot.assets.every(a=>a.mediaUrl&&a.objectRevisionId&&a.expectedVersion&&a.prompt));}
const directory=await get('workspaces/material-directory');assert.equal(directory.trials.reduce((n,t)=>n+t.versions.length,0),20);
const asset=snapshots.flatMap(s=>s.assets).find(a=>!a.reviewLock.locked&&a.lifecycle!=='RELEASED');assert.ok(asset);
const input={objectId:asset.id,objectRevisionId:asset.objectRevisionId,expectedVersion:asset.expectedVersion,reviewSpecHash:asset.reviewSpecHash,mediaId:asset.mediaId,versionId:asset.versionId,sha256:asset.sha256,scopeId:asset.scopeId,decision:'REVISION_REQUIRED',comment:'仅隔离候选目录与判断回读核验',criteria:asset.reviewCriteria.map(c=>({id:c.id,result:'FAIL',comment:'仅隔离核验'})),...(asset.reviewHeadId?{supersedesReviewEventId:asset.reviewHeadId}:{})};
async function post(body,key=crypto.randomUUID()){const r=await fetch(base+'workspaces/candidates/reviews',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Runtime':profile.deployment.runtimeEpoch,'Idempotency-Key':key},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};}
let result=await post({...input,sha256:'0'.repeat(64)});assert.equal(result.status,409);
const key=crypto.randomUUID();result=await post(input,key);assert.equal(result.status,200,JSON.stringify(result.value));assert.equal((await post(input,key)).status,200);assert.equal((await post(input)).status,409);
const fresh=(await get('workspaces/candidates/snapshot?scopeId='+asset.scopeId)).assets.find(a=>a.id===asset.id);assert.equal(fresh.latestReview.payload.comment,input.comment);assert.equal(fresh.lifecycle,'REVISION_REQUIRED');
console.log('PASS 20 original candidates in both original scopes, exact media, catalog visibility, strict CAS and review readback');
