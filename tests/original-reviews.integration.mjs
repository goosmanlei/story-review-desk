import assert from 'node:assert/strict';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()),'Use the managed process runner');
const base=(process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913')+'/api/v1/';
async function get(path){const r=await fetch(base+path),v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v;}
const profile=await get('workspaces/profile');assert.match(profile.instanceId,/^ui-fixture-/);
async function post(path,body,key=crypto.randomUUID()){const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Runtime':profile.deployment.runtimeEpoch,'Idempotency-Key':key},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};}
async function ok(value){const r=await value;assert.equal(r.status,200,JSON.stringify(r.value));return r.value;}

let preparation=await get('workspaces/production-preparation'),scene=preparation.content.scenes[0];
const original=structuredClone(scene.preparation),changed={...original,nextPreparationAction:original.nextPreparationAction+' · 隔离保存核验'};
const body={action:'save',objectId:scene.objectId,sceneId:scene.sceneId,expectedVersion:scene.expectedVersion,expectedRevisionId:scene.revisionId,preparation:changed};
const key=crypto.randomUUID(),saved=await ok(post('workspaces/production-preparation',body,key));
assert.deepEqual(await ok(post('workspaces/production-preparation',body,key)),saved);
assert.equal((await post('workspaces/production-preparation',body)).status,409);
preparation=await get('workspaces/production-preparation');scene=preparation.content.scenes.find(s=>s.objectId===scene.objectId);
assert.equal(scene.preparation.nextPreparationAction,changed.nextPreparationAction);
await ok(post('workspaces/production-preparation',{...body,preparation:original,expectedVersion:scene.expectedVersion,expectedRevisionId:scene.revisionId}));
preparation=await get('workspaces/production-preparation');scene=preparation.content.scenes.find(s=>s.objectId===scene.objectId);
const comment=await ok(post('workspaces/production-preparation',{action:'comment',objectId:scene.objectId,sceneId:scene.sceneId,expectedVersion:scene.expectedVersion,expectedRevisionId:scene.revisionId,text:'隔离准备稿意见'}));
assert.ok((await get('workspaces/production-preparation')).comments.some(c=>c.commentId===comment.commentId));
console.log('PASS preparation save, replay, stale save rejection and comment readback');

let plan=(await get('workspaces/views/episode-plan')).plan;
let episode=plan.content.episodes.find(e=>e.objectState==='DRAFT');assert.ok(episode);
let detail=await get('objects/'+encodeURIComponent(episode.episodeUid));
const spec=detail.revision.content.reviewSpec;
const review={episodeUid:episode.episodeUid,subjectRevisionId:plan.revisionId,objectRevisionId:detail.revision.id,expectedVersion:detail.version,reviewSpecHash:spec.hash,reviewAction:'APPROVE_AND_RELEASE',criterionFindings:spec.criteria.map(c=>({criterionId:c.id,verdict:'PASS',note:'隔离接口验收'})),note:'仅隔离验收'};
const decision=await ok(post('workspaces/episode-plan-reviews',review));
assert.equal(decision.adopted,true);detail=await get('objects/'+encodeURIComponent(episode.episodeUid));assert.equal(detail.state,'ADOPTED');
assert.equal((await post('workspaces/episode-plan-reviews',review)).status,409);
const heads=await get('workspaces/episode-plan-reviews');assert.ok(heads.episodeReleases.find(e=>e.episodeUid===episode.episodeUid)?.canFlowDownstream);
console.log('PASS a single episode decision adopts the exact object revision');

const entry=await get('workspaces/episode-production?episodeUid='+plan.content.episodes[0].episodeUid+'&sceneId='+plan.content.episodes[0].sceneIds[0]);
const design=entry.plans.find(p=>p.kind==='SHOT_PLAN_SET');assert.ok(design.candidate);
const shots=structuredClone(design.template.content.shots);shots[0].visualIntent+=' · 隔离镜头修改验收';
const change={subjectKind:'SHOT_PLAN_SET',subjectId:design.template.planId,objectRevisionId:design.candidate.creativeRevisionId,expectedVersion:design.candidate.expectedVersion,baseRevisionHash:design.template.revisionHash,basisBindings:design.basisBindings,content:{sceneId:shots[0].sceneId,identityChangeReason:'NO_IDENTITY_CHANGE',shots}};
const written=await ok(post('workspaces/creative-revisions',change));
const object=await get('objects/'+encodeURIComponent(design.template.planId));
assert.equal(object.revision.id,written.creativeRevisionId);
assert.equal(object.state,'DRAFT');
assert.equal(object.dependencies.filter(d=>d.purpose==='DESIGN').length,shots.length);
assert.equal((await post('workspaces/creative-revisions',change)).status,409);
console.log('PASS shot design edit, exact shot revision dependencies, draft status and stale rejection');

const material=await get('workspaces/views/materials');
const operations=await get('workspaces/operations/snapshot');
const candidate=Object.values(operations.stateProjection.assetVersionsById).find(v=>v.lifecycleState==='REVIEW_PENDING'&&v.outputState==='PRESENT'&&v.rightsFact!=='BLOCKED'&&material.page.materialRequirements.some(q=>q.assetFamilyRefs.includes(v.familyId)&&q.reviewSpec?.criteria?.length));
assert.ok(candidate,'Fixture needs a pending artifact with a frozen requirement');
const requirement=material.page.materialRequirements.find(q=>q.assetFamilyRefs.includes(candidate.familyId)&&q.reviewSpec?.criteria?.length);
const assetReview={subjectType:'ASSET',subjectId:candidate.familyId,familyId:candidate.familyId,versionId:candidate.id,versionSha256:candidate.sha256,objectRevisionId:candidate.revisionId,expectedVersion:candidate.objectVersion,requirementId:requirement.id,requirementRevisionId:requirement.revisionId,requirementVersion:requirement.objectVersion,reviewSpecHash:requirement.reviewSpec.hash,contextHash:candidate.reviewContextHash,action:'APPROVE_AND_RELEASE',criterionFindings:requirement.reviewSpec.criteria.map(c=>({criterionId:c.id,verdict:'PASS',note:'隔离素材审阅'})),note:'仅隔离验收'};
if(candidate.rightsFact==='UNKNOWN')assetReview.rightsUnknownConfirmation={confirmed:true,scope:'PROJECT_INTERNAL_ONLY',basis:'仅隔离 fixture 核验权利事实与采用分开记录，不作用于原实例'};
const assetDecision=await ok(post('workspaces/reviews',assetReview));assert.equal(assetDecision.adopted,true);
const after=await get('workspaces/operations/snapshot'),version=after.stateProjection.assetVersionsById[candidate.id];
assert.equal(version.reviewCorrection.headEventId,assetDecision.eventId);assert.equal(version.lifecycleState,'RELEASED');
assert.ok(after.reviews.events.some(e=>e.eventId===assetDecision.eventId&&e.familyId===candidate.familyId&&e.versionId===candidate.id&&e.effect==='APPLIED'));
console.log('PASS material review criteria, adoption and original review-history contract');
