import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {requiredPhase} from '../tools/process-resources.mjs';
assert.ok(await requiredPhase(process.cwd()));
const base=process.env.REVIEW_UI_BASE||'http://127.0.0.1:3916',mode='MATERIAL_OVERALL_V1';
const get=async p=>{const r=await fetch(base+'/api/v1/'+p);assert.equal(r.status,200,await r.clone().text());return r.json()};
const profile=await get('workspaces/profile');assert.match(profile.instanceId,/^ui-fixture-/);
const post=async(p,body,id=randomUUID())=>{const r=await fetch(base+'/api/v1/'+p,{method:'POST',headers:{'Content-Type':'application/json','X-Review-Runtime':profile.deployment.runtimeEpoch,'Idempotency-Key':id},body:JSON.stringify({...body,operationId:id})});return {status:r.status,data:await r.json()};};
const ok=async result=>{const r=await result;assert.equal(r.status,200,JSON.stringify(r.data));assert.notEqual(r.data.status,'FAILED',JSON.stringify(r.data));return r.data;};
const catalog=(await get('workspaces/views/material-catalog')).page;
let operations=await get('workspaces/operations/snapshot');
const families=new Set(),candidates=Object.values(operations.stateProjection.assetVersionsById).filter(v=>{
 if(v.lifecycleState!=='REVIEW_PENDING'||v.outputState!=='PRESENT'||v.rightsFact==='BLOCKED'||v.historyRole==='HISTORICAL'||families.has(v.familyId))return false;
 if(!catalog.materialRequirements.some(q=>q.assetFamilyRefs.includes(v.familyId)))return false;families.add(v.familyId);return true;
});assert.ok(candidates.length>=3,'three independent pending material families required');
async function inputs(candidate){
 const q0=catalog.materialRequirements.find(q=>q.assetFamilyRefs.includes(candidate.familyId));
 const page=(await get('workspaces/views/materials?requirementId='+encodeURIComponent(q0.id))).page;
 const q=page.materialRequirements.find(q=>q.id===q0.id),v=page.assetVersions.find(v=>v.id===candidate.id);
 const focus=await get('workspaces/material-review-focus?'+new URLSearchParams({requirementId:q.id,versionId:v.id}));
 return {q,v,focus,body:{subjectType:'ASSET',subjectId:v.familyId,familyId:v.familyId,versionId:v.id,versionSha256:v.sha256,objectRevisionId:v.revisionId,expectedVersion:v.objectVersion,requirementId:q.id,requirementRevisionId:q.revisionId,requirementVersion:q.objectVersion,reviewSpecHash:q.reviewSpec.hash,businessContextHash:focus.contextHash,reviewMode:mode,criterionFindings:[],action:'REQUEST_REVISION',note:'整体核验说明'}};
}
const first=await inputs(candidates[0]),before=await get('objects/'+encodeURIComponent(first.v.id));
for(const bad of [{note:''},{note:' \n '},{criterionFindings:first.q.reviewSpec.criteria.map(c=>({criterionId:c.id,verdict:'PASS',note:''}))},{revisionInstructions:{preserve:[],change:['旧字段'],mustNotRegress:[]}},{action:'DO_NOT_USE'}])assert.equal((await post('workspaces/reviews',{...first.body,...bad})).status,400);
for(const bad of [{versionSha256:'0'.repeat(64)},{requirementVersion:0},{reviewSpecHash:'0'.repeat(64)},{businessContextHash:'0'.repeat(64)}])assert.equal((await post('workspaces/reviews',{...first.body,...bad})).status,409);
assert.equal((await get('objects/'+encodeURIComponent(first.v.id))).version,before.version);
const browser=await chromium.launch({channel:'chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const url=base+'/?view=materials&material='+encodeURIComponent(first.q.id)+'&family='+encodeURIComponent(first.v.familyId)+'&version='+encodeURIComponent(first.v.id);
 await page.goto(url,{waitUntil:'networkidle'});
 const form=page.locator('.material-review-form');await form.waitFor();await form.getByRole('heading',{name:'此素材的关注重点'}).waitFor();
 const input=form.getByRole('textbox',{name:'整体审阅说明',exact:true});
 assert.equal(await form.locator('.material-criteria-list article').count(),first.q.reviewSpec.criteria.length);
 assert.equal(await form.locator('.material-criteria-list input,.material-criteria-list select,.material-criteria-list textarea,.material-criteria-list button').count(),0);
 assert.equal(await form.getByRole('textbox').count(),1);
 assert.equal(await form.getByRole('button',{name:'禁止使用',exact:true}).count(),0);
 assert.equal(await page.getByRole('button',{name:'结合这条意见问助手',exact:true}).count(),0);
 await form.getByRole('button',{name:'要求修改',exact:true}).click();
 const submit=form.getByRole('button',{name:'提交正式裁决',exact:true});await expect(submit).toBeDisabled();await input.fill('   ');await expect(submit).toBeDisabled();
 await input.fill('刷新后保留的整体意见');await page.reload({waitUntil:'networkidle'});await expect(input).toHaveValue('刷新后保留的整体意见');
 // A real entity edit changes the business basis without changing the asset or its review head.
 const identity=first.focus.sections.find(s=>s.label==='主体身份');assert.ok(identity);
 const entity=await get('objects/'+encodeURIComponent(identity.source.objectId));
 await ok(post('transactions',{commands:[{type:'save',id:entity.id,expectedVersion:entity.version,content:{...entity.revision.content,description:(entity.revision.content.description||'')+' · 隔离并发属性变更'}}]}));
 const rejected=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/workspaces/reviews'));
 await expect(submit).toBeEnabled();await submit.click();assert.equal((await rejected).status(),409);await expect(input).toHaveValue('刷新后保留的整体意见');
 await form.getByRole('button',{name:'已核对当前依据，保留说明',exact:true}).click();await expect(input).toHaveValue('刷新后保留的整体意见');
 await form.getByRole('button',{name:'AI 辅助审阅',exact:true}).click();await form.getByRole('button',{name:'填入整体审阅说明',exact:true}).waitFor({timeout:30000});
 await expect(input).toHaveValue('刷新后保留的整体意见');
 await form.getByRole('button',{name:'填入整体审阅说明',exact:true}).click();await expect(input).toHaveValue(/请核对主体状态/);
 await expect(form.getByRole('button',{name:'要求修改',exact:true})).toHaveAttribute('aria-pressed','false');await expect(form.getByRole('button',{name:'通过并采用',exact:true})).toHaveAttribute('aria-pressed','false');
 const untouched=await get('objects/'+encodeURIComponent(first.v.id));assert.equal(untouched.version,before.version);assert.equal(untouched.reviews.length,before.reviews.length);
 await input.fill('只提交整体要求修改说明');await form.getByRole('button',{name:'要求修改',exact:true}).click();await expect(submit).toBeEnabled();await submit.click();
 await expect.poll(async()=> (await get('objects/'+encodeURIComponent(first.v.id))).state).toBe('CHANGES_REQUESTED');
 const after=await get('objects/'+encodeURIComponent(first.v.id));assert.deepEqual(after.reviews.at(-1).findings,[]);assert.equal(after.adoptedRevisionId,before.adoptedRevisionId);assert.deepEqual(after.rights,before.rights);assert.equal(after.revision.id,before.revision.id);
 assert.deepEqual(errors,[]);
}finally{await browser.close();}
// Empty approval notes are accepted without fabricating per-criterion results.
const second=await inputs(candidates[1]),approved=await ok(post('workspaces/reviews',{...second.body,action:'APPROVE_AND_RELEASE',note:'',...(candidates[1].rightsFact==='UNKNOWN'?{rightsUnknownConfirmation:{confirmed:true,scope:'PROJECT_INTERNAL_ONLY',basis:'仅隔离fixture内部使用确认，权利原事实不改变'}}:{})}));assert.equal(approved.adopted,true);
const secondObject=await get('objects/'+encodeURIComponent(second.v.id));assert.deepEqual(secondObject.reviews.at(-1).findings,[]);assert.equal(secondObject.reviews.at(-1).note,'');
// Direct commands use the same exact requirement, SHA and business-context boundary.
const third=await inputs(candidates[2]),thirdObject=await get('objects/'+encodeURIComponent(third.v.id)),needsSubmit=thirdObject.state!=='SUBMITTED';await ok(post('transactions',{commands:[...(needsSubmit?[{type:'submit',id:third.v.id,expectedVersion:third.v.objectVersion}]:[]),{type:'review',id:third.v.id,expectedVersion:third.v.objectVersion+(needsSubmit?1:0),revisionId:third.v.revisionId,decision:'REQUEST_CHANGES',explicit:true,note:'底层整体审阅',findings:[],reviewMode:mode,businessContextHash:third.focus.contextHash,reviewBasis:{id:third.q.id,expectedVersion:third.q.objectVersion,revisionId:third.q.revisionId,reviewSpecHash:third.q.reviewSpec.hash},reviewMetadata:{versionId:third.v.id,versionSha256:third.v.sha256}}]}));
const prefix='overall-fixture-'+randomUUID(),sceneId=prefix+'-scene';
await ok(post('transactions',{commands:[{type:'save',id:sceneId,kind:'SCENE',title:'其他页面审阅边界',expectedVersion:0,content:{blocks:[{id:'b1',type:'action',text:'隔离场景正文'}],reviewSpec:third.q.reviewSpec}},{type:'submit',id:sceneId,expectedVersion:1}]}));
const scene=await get('objects/'+sceneId),sceneReview={type:'review',id:sceneId,expectedVersion:scene.version,revisionId:scene.revision.id,decision:'REQUEST_CHANGES',explicit:true,note:'不能借素材模式绕过',findings:[]};
assert.equal((await post('transactions',{commands:[{...sceneReview,reviewMode:mode}]})).status,400);
assert.equal((await post('transactions',{commands:[sceneReview]})).status,400);
const domain=await get('workspaces/domain-workspaces?owner=MATERIAL');operations=await get('workspaces/operations/snapshot');
const source=Object.values(operations.stateProjection.assetVersionsById).find(v=>v.lifecycleState==='RELEASED'&&v.outputState==='PRESENT'&&v.rightsFact==='CLEAR'&&domain.graph.representations.some(r=>r.assetFamilyIds.includes(v.familyId))&&catalog.assetVersions.some(a=>a.id===v.id&&a.mediaKind==='IMAGE'));
assert.ok(source,'adopted image with exact entity context required');
const target={familyId:source.familyId,versionId:source.id,sha256:source.sha256};
async function completeAncillary(endpoint,target,content){
 const state=await get('workspaces/'+endpoint+'?'+new URLSearchParams(target));assert.equal(state.readOnly,false,JSON.stringify(state.blockers));
 const wrong=structuredClone(content(state));if(endpoint==='material-usage'){wrong.decision.action='REQUEST_REVISION';wrong.decision.note=' ';}else{wrong.action='REQUEST_CURRENT_DOMAIN_REVISION';wrong.note=' ';}
 const save={action:'save',...target,expectedReleaseId:state.releaseId,expectedBasisHash:state.basisHash,expectedDraftRevisionId:state.draftHeadRevisionId};
 assert.equal((await post('workspaces/'+endpoint,{...save,content:wrong})).status,400);
 const draft=await ok(post('workspaces/'+endpoint,{...save,content:content(state)}));
 const preview=await ok(post('workspaces/'+endpoint,{action:'preview',...target,draftRevisionId:draft.revisionId}));
 return ok(post('workspaces/'+endpoint,{action:'publish',...target,draftRevisionId:draft.revisionId,previewHash:preview.previewHash}));
}
const sourceBefore=await get('objects/'+encodeURIComponent(source.id));
await completeAncillary('material-usage',{...target,requirementId:first.q.id},state=>({reviewMode:mode,purposeNote:'仅隔离检验该图片的新用途',authorization:{scope:'PROJECT_INTERNAL_ONLY',basis:'仅隔离图片用途测试'},observation:{versionId:source.id,sha256:source.sha256,originalViewed:true,note:''},decision:{action:'APPROVE_AND_RELEASE',reviewSpecHash:state.reviewSpec.hash,criterionFindings:[],note:''}}));
await completeAncillary('asset-context-revalidation',target,()=>({reviewMode:mode,purpose:'LEGACY_ADOPTION_DOMAIN_REVALIDATION',action:'REQUEST_CURRENT_DOMAIN_REVISION',observedVersionId:source.id,observedSha256:source.sha256,originalViewed:true,criterionFindings:[],note:'当前关系还需要核对'}));
const contextHead=(await get('workspaces/asset-context-revalidation?'+new URLSearchParams(target))).head;assert.equal(contextHead.action,'REQUEST_REVISION');assert.equal(contextHead.note,'当前关系还需要核对');assert.deepEqual(contextHead.criterionFindings,[]);
const sourceAfter=await get('objects/'+encodeURIComponent(source.id));assert.equal(sourceAfter.version,sourceBefore.version);assert.equal(sourceAfter.adoptedRevisionId,sourceBefore.adoptedRevisionId);assert.deepEqual(sourceAfter.rights,sourceBefore.rights);
// Frozen history uses the old definition revision even after a current edit.
const entityId=prefix+'-entity',qId=prefix+'-requirement',assetId=prefix+'-historical';
await ok(post('transactions',{commands:[{type:'save',id:entityId,kind:'ENTITY',title:'冻结主体',expectedVersion:0,content:{name:'冻结主体',type:'CHARACTER',description:'冻结时的独特状态',authority:'A',evidence:[]}}]}));
const entity=await get('objects/'+entityId);
await ok(post('transactions',{commands:[{type:'save',id:qId,kind:'REQUIREMENT',title:'冻结需求',expectedVersion:0,content:{mediaType:'IMAGE',description:'仅用于验证冻结业务上下文',reviewSpec:first.q.reviewSpec,storyBasis:{whyNeeded:'冻结的剧情用途'}},links:[{id:entityId,role:'ENTITY'},{id:source.familyId,role:'FAMILY'}],dependencies:[{revisionId:entity.revision.id,purpose:'DEFINITION'}]}]}));
const frozenQ=await get('objects/'+qId);
await ok(post('transactions',{commands:[{type:'save',id:assetId,kind:'ASSET',title:'仅历史上下文夹具，未登记实际媒体',expectedVersion:0,content:{label:'历史资料',historyRole:'HISTORICAL'},links:[{id:source.familyId,role:'FAMILY'}],dependencies:[{revisionId:frozenQ.revision.id,purpose:'DEFINITION'}]},{type:'save',id:entityId,expectedVersion:entity.version,content:{...entity.revision.content,description:'当前新状态不可填回历史'}}]}));
const frozen=await get('workspaces/material-review-focus?'+new URLSearchParams({requirementId:first.q.id,versionId:assetId}));assert.equal(frozen.historical,true);assert.equal(frozen.requirementRevisionId,frozenQ.revision.id);assert.ok(frozen.sections.some(s=>s.text==='冻结时的独特状态'));assert.ok(!frozen.sections.some(s=>s.text==='当前新状态不可填回历史'));assert.deepEqual(frozen.rules,[]);
console.log(JSON.stringify({status:'PASS',checks:['readonly standards','single overall note','blank revision rejected in UI and API','empty approval allowed','no artificial findings','exact SHA and basis CAS','retained note on reload','controlled AI sees business context','AI preview/apply/action separation','material assistant shortcut absent','native command scope','legacy scene criteria retained','usage and context overall contracts','source adoption and rights unchanged','frozen historical context'],realModelCalls:0}));
