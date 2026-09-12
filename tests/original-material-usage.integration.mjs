import assert from 'node:assert/strict';
import {requiredPhase} from '../tools/process-resources.mjs';
import {validUsageSelection,validUsageWorkspace,validUsageReceipt} from '../web/app/material-usage-client.mjs';
import {validContextWorkspace,validContextReceipt} from '../web/app/asset-context-revalidation-client.mjs';
assert.ok(await requiredPhase(process.cwd()),'Use managed runner');
const base=(process.env.REVIEW_UI_BASE||'http://127.0.0.1:3913')+'/api/v1/';
const get=async path=>{const r=await fetch(base+path),v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v;};
const profile=await get('workspaces/profile');assert.match(profile.instanceId,/^ui-fixture-/);
async function post(path,body,key=crypto.randomUUID()){const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Runtime':profile.deployment.runtimeEpoch,'Idempotency-Key':key},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};}
const ok=async p=>{const r=await p;assert.equal(r.status,200,JSON.stringify(r.value));return r.value;};
const catalog=(await get('workspaces/views/materials')).page,requirementId=catalog.materialRequirements.find(r=>(r.mediaType==='IMAGE'||r.mediaKind==='IMAGE')&&r.reviewSpec?.criteria?.length).id,selection=validUsageSelection(await get('workspaces/material-usage?requirementId='+requirementId),requirementId);
assert.ok(selection.eligibleSources.length);
const requirementFamilies=catalog.materialRequirements.find(r=>r.id===requirementId).assetFamilyRefs;
const source=selection.eligibleSources.find(v=>!requirementFamilies.includes(v.familyId))||selection.eligibleSources[0],target={requirementId,familyId:source.familyId,versionId:source.versionId,sha256:source.sha256},query='?'+new URLSearchParams(target);
const before=await get('objects/'+encodeURIComponent(source.versionId));
let state=validUsageWorkspace(await get('workspaces/material-usage'+query),target);
const content={purposeNote:'仅隔离用途复核测试',authorization:{scope:'PROJECT_INTERNAL_ONLY',basis:'仅隔离受控验收'},observation:{versionId:target.versionId,sha256:target.sha256,originalViewed:true,note:'测试模拟用户已核对原件，不构成正式项目观察'},decision:{action:'APPROVE_AND_RELEASE',reviewSpecHash:state.reviewSpec.hash,criterionFindings:state.reviewSpec.criteria.map(c=>({criterionId:c.id,verdict:'PASS',note:'受控测试判断'})),note:'仅隔离用途采用测试'}};
const input={action:'save',...target,expectedReleaseId:state.releaseId,expectedBasisHash:state.basisHash,expectedDraftRevisionId:state.draftHeadRevisionId,content},key=crypto.randomUUID();
let result=await ok(post('workspaces/material-usage',input,key));validUsageReceipt(result,'save',state);assert.deepEqual(await ok(post('workspaces/material-usage',input,key)),result);assert.equal((await post('workspaces/material-usage',{...input,content:{...content,purposeNote:'changed'}},key)).status,409);
state=validUsageWorkspace(await get('workspaces/material-usage'+query),target);
result=validUsageReceipt(await ok(post('workspaces/material-usage',{action:'preview',...target,draftRevisionId:state.draft.revisionId})),'preview',state);
result=validUsageReceipt(await ok(post('workspaces/material-usage',{action:'publish',...target,draftRevisionId:state.draft.revisionId,previewHash:result.previewHash})),'publish',state);assert.equal(result.status,'SUCCEEDED');
assert.equal((await get('objects/'+encodeURIComponent(source.versionId))).version,before.version);
let projection=await get('workspaces/views/materials?requirementId='+requirementId);assert.equal(projection.page.materialRequirements.find(r=>r.id===requirementId).coverageSatisfied,true);
let contextState,contextTarget;
for(const candidate of selection.eligibleSources.slice(0,12)){
  const t={familyId:candidate.familyId,versionId:candidate.versionId,sha256:candidate.sha256},w=validContextWorkspace(await get('workspaces/asset-context-revalidation?'+new URLSearchParams(t)),t);
  if(!w.blockers.length){contextState=w;contextTarget=t;break;}
}
assert.ok(contextState,'An adopted image with exact current domain bindings is available');
const c={purpose:'LEGACY_ADOPTION_DOMAIN_REVALIDATION',action:'CONFIRM_CURRENT_DOMAIN',observedVersionId:contextTarget.versionId,observedSha256:contextTarget.sha256,originalViewed:true,criterionFindings:contextState.reviewSpec.criteria.map(c=>({criterionId:c.id,verdict:'PASS',note:'隔离关系复核测试'})),note:'仅受控验收'};
const contextInput={action:'save',...contextTarget,expectedReleaseId:contextState.releaseId,expectedBasisHash:contextState.basisHash,expectedDraftRevisionId:contextState.draftHeadRevisionId,content:c};
assert.equal((await post('workspaces/asset-context-revalidation',{...contextInput,content:{...c,originalViewed:false}})).status,400);
validContextReceipt(await ok(post('workspaces/asset-context-revalidation',contextInput)),'save',contextState);
contextState=validContextWorkspace(await get('workspaces/asset-context-revalidation?'+new URLSearchParams(contextTarget)),contextTarget);
const preview=validContextReceipt(await ok(post('workspaces/asset-context-revalidation',{action:'preview',...contextTarget,draftRevisionId:contextState.draft.revisionId})),'preview',contextState);
validContextReceipt(await ok(post('workspaces/asset-context-revalidation',{action:'publish',...contextTarget,draftRevisionId:contextState.draft.revisionId,previewHash:preview.previewHash})),'publish',contextState);
const requirement=await get('objects/'+requirementId);
const changed=await ok(post('transactions',{operationId:crypto.randomUUID(),runtimeEpoch:profile.deployment.runtimeEpoch,actor:{kind:'HUMAN',label:'隔离测试'},commands:[{type:'save',id:requirementId,expectedVersion:requirement.version,content:{...requirement.revision.content,description:(requirement.revision.content.description||'')+' · 新的隔离需求版本'}}]}));assert.equal(changed.status,'SUCCEEDED');
projection=await get('workspaces/views/materials?requirementId='+requirementId);assert.equal(projection.page.materialRequirements.find(r=>r.id===requirementId).coverageSatisfied,false);
console.log('PASS original reuse/context contracts, preview and atomic judgment, observation gate, operation replay, asset history unchanged, exact requirement version invalidation');
