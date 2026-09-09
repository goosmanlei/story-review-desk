import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {sha256} from '../host/instance-runtime/bytes.mjs';
import {domainHash} from '../host/instance-runtime/domain-model.mjs';
import {previewDomainProductionCompatibility,applyDomainProductionCompatibility,DOMAIN_COMPATIBILITY_NS} from '../host/instance-runtime/domain-production-compatibility-service.mjs';
import {apiFixture,pngs} from './fixtures/material-native-revision-api.mjs';
import {changeDomain,imageRequirementId,imageRepresentationId} from './material-production-fixture.mjs';
import {getMaterialProductionWorkspace,applyMaterialProductionJob} from '../host/instance-runtime/material-production-service.mjs';

// 真实独立 UUID PostgreSQL、临时根目录和微型 PNG；fixture 拦截全部外部 fetch。
// 只验证协议与字节闭包，不代表真实媒体观察、故事裁决或模型调用。
const pg={skip:process.env.REVIEW_TEST_POSTGRES!=='1',timeout:180000};
const entityId='character:letter-writer';
const quote='用户明确允许对已核对的叙事说明纠正与同条件范围追加作精确兼容核验，不授权生成。';
const deps=f=>({api:f.adapter,instanceRoot:f.root});
const preview=(f,input)=>f.repo.readTransaction(tx=>previewDomainProductionCompatibility(tx,input,deps(f)));
const apply=(f,input,previewHash)=>f.repo.writeTransaction(tx=>applyDomainProductionCompatibility(tx,input,{...deps(f),expectedPreviewHash:previewHash}));
const target=(p,c)=>({familyId:p.result.familyId,versionId:c.versionId,sha256:c.sha256});

async function authorize(f,{legacy=false}={}){
 return f.repo.writeTransaction(async tx=>{
  const view=await tx.readView(),metadata=legacy?{sourceRole:'MACHINE_MODEL_SOURCE',migrationRebase:'GUIDANCE_REBASE_TO_ACTUAL_BYTES',legacyExpectedSha256:sha256('原迁移说明夹具')}:{sourceRole:'PROJECT_GUIDANCE'};
  const doc=await tx.putDocument({documentId:'guidance:compatibility-test',aliases:['STATE.md'],expectedRevisionId:null,bytes:quote,metadata});
  await tx.publishRelease({snapshot:view.snapshot,recipes:view.recipes,sourceRevisionIds:[...view.sourceRevisionIds,doc.revisionId],expectedReleaseId:view.releaseId});
  return {alias:'STATE.md',revisionId:doc.revisionId,sha256:doc.sha256,quote,confirmed:true};
 });
}
async function requestFor(f,before,authorization,{versions=[],requirementIds=[],metadataApprovals=[]}={}){
 const after=await f.repo.readView(),meta=await f.repo.getMetadata();
 return {schemaVersion:'DOMAIN_PRODUCTION_COMPATIBILITY_REQUEST_V1',operationId:'compatibility_'+randomUUID(),expectedReleaseId:after.releaseId,expectedRuntimeEpoch:meta.runtimeEpoch,beforeReleaseId:before.releaseId,beforeGraphRef:before.snapshot.productionModel.domainGraphRef,afterGraphRef:after.snapshot.productionModel.domainGraphRef,versions,requirementIds,metadataApprovals,authorization,reason:'仅复用本次明确核验的原生产契约，原裁决、来源与实际输入保持不变。'};
}
async function approvedFixture(t,{successor=false}={}){
 const f=await apiFixture(t),first=await f.provision(await f.workspace(),'原生初版固定 PNG 协议夹具；不调用模型。'),firstCandidate=await f.register(first,await f.beginRun(first),pngs[0]);
 const firstReview=await f.review(first,firstCandidate,'APPROVE_AND_RELEASE');
 let production=first,candidate=firstCandidate,review=firstReview;
 if(successor){
  production=await f.provision(await f.workspace(),'原生同族返修固定 PNG；保留真实原版本和来源。',{expectedMode:'REVISION'});
  candidate=await f.register(production,await f.beginRun(production),pngs[1]);review=await f.review(production,candidate,'APPROVE_AND_RELEASE');
 }
 return {...f,production,candidate,reviewEvent:review,first,firstCandidate,firstReview};
}
async function descriptionChange(f,{legacy=false,beforeHook}={}){
 const authorization=await authorize(f,{legacy}),before=await f.repo.readView();
 if(beforeHook)await beforeHook();
 const oldEntity=before.snapshot.productionModel.domainGraph.entities.find(e=>e.id===entityId),newEntity={...oldEntity,description:'青年女性；更正当下拒绝离开的叙事动机，外貌与制作规格保持不变。'};
 await changeDomain(f.repo,'SETTINGS',[{collection:'entities',id:entityId,beforeHash:domainHash(oldEntity),value:newEntity}]);
 const input=await requestFor(f,before,authorization,{versions:[target(f.production,f.candidate)],metadataApprovals:[{entityId,beforeRecordHash:domainHash(oldEntity),afterRecordHash:domainHash(newEntity),confirmed:true,reason:'仅叙事说明纠正；未改变外貌、物性、权利或实际输入。',authorizationRef:authorization.revisionId+':'+authorization.sha256,scope:'NARRATIVE_DESCRIPTION_ONLY'}]});
 return {before,input};
}
async function facts(f){
 const view=await f.repo.readView(),media=await f.repo.readTransaction(tx=>tx.listMedia());
 return {view,media,bytes:await Promise.all(media.map(async m=>({mediaId:m.mediaId,versionId:m.versionId,sha256:sha256(await readFile(path.join(f.root,m.relativePath)))}))),documents:await Promise.all(view.sourceRevisionIds.map(id=>f.repo.readDocumentRevision(id)))};
}
async function rejectedUnchanged(f,input,pattern,hash){
 const before=await f.repo.exportState();
 await assert.rejects(hash?apply(f,input,hash):preview(f,input),pattern);
 assert.deepEqual(await f.repo.exportState(),before,'拒绝不得新增兼容记录、回执、事件或发布');
}
async function reviewRequest(f,{action='REQUEST_REVISION',supersedesReviewEventId,requirementId=imageRequirementId,production=f.production,candidate=f.candidate}={}){
 const data=await f.store.reviewData(),spec=data.productionModel.materialRequirements.find(r=>r.id===requirementId).reviewSpec;
 return f.post(f.reviews,'v8/reviews',{schemaVersion:'2.2',subjectType:'ASSET',subjectId:production.result.familyId,familyId:production.result.familyId,versionId:candidate.versionId,versionSha256:candidate.sha256,contextHash:f.store.assetReviewContextHash(data,production.result.familyId,candidate.versionId,candidate.sha256),reviewSpecHash:spec.hash,action,
  criterionFindings:spec.criteria.map((c,i)=>({criterionId:c.id,verdict:action==='REQUEST_REVISION'&&i===0?'FAIL':'PASS',note:'只核对临时固定 PNG 的协议事实，不是媒体艺术观察。'})),
  revisionInstructions:action==='REQUEST_REVISION'?{preserve:['保持夹具身份'],change:['采用另一个固定测试 PNG'],mustNotRegress:['保留原版本历史']}:null,
  ...(action==='APPROVE_AND_RELEASE'?{rightsUnknownConfirmation:{confirmed:true,scope:'PROJECT_INTERNAL_ONLY',basis:'测试自制微型 PNG，不代表正式项目权利确认。'}}:{}),
  ...(supersedesReviewEventId?{supersedesReviewEventId}:{}),note:'独立临时 PostgreSQL 纠错协议测试。'});
}
async function scopeAddition(f,label){
 const before=await f.repo.readView(),sceneId='scene:'+label,revisionId='scene-revision:'+label;let evidence;
 await f.repo.writeTransaction(async tx=>{
  const view=await tx.readView(),snapshot=structuredClone(view.snapshot),text='本场只复用同一物性和身份：'+label,doc=await tx.putDocument({documentId:'scope:'+label,aliases:['story/compatibility-test/'+label+'.txt'],expectedRevisionId:null,bytes:text,metadata:{sourceRole:'SOURCE_DOCUMENT'}});
  evidence={sourceId:'source_'+doc.sha256,revisionId:doc.revisionId,sha256:doc.sha256,locator:sceneId+'/block:1',quote:text};
  snapshot.productionModel.sceneScriptRevisions.push({id:revisionId,sceneId,isCurrent:true,contentHash:domainHash(label),sourceRevisionId:doc.revisionId,sourceSha256:doc.sha256});
  await tx.publishRelease({snapshot,recipes:view.recipes,sourceRevisionIds:[...view.sourceRevisionIds,doc.revisionId],expectedReleaseId:view.releaseId});
 });
 const demand=before.snapshot.productionModel.domainGraph.requirements.find(r=>r.id===imageRequirementId);
 await changeDomain(f.repo,'MATERIAL',[{collection:'requirements',id:demand.id,beforeHash:domainHash(demand),value:{...demand,scope:[...demand.scope,{scopeType:'SCENE',scopeId:sceneId,revisionId}],evidence:[...demand.evidence,evidence]}}]);
}

test('真实 PG：原生已通过版本 preview/apply 只追加精确兼容事实，事件、媒体、来源和配方不变且幂等',pg,async t=>{
 const f=await approvedFixture(t),{input}=await descriptionChange(f,{legacy:true}),before=await facts(f),p=await preview(f,input);
 assert.equal(p.record.versionBindings.length,1);assert.equal(p.record.versionBindings[0].reviewEventId,f.reviewEvent.eventId);
 assert.equal(p.record.versionBindings[0].executionDefinitionId,f.production.recipe.id);
 assert.equal(p.record.contractAudit.media.length,1);assert.equal(p.formalAdoptionPerformed,false);assert.equal(p.modelCalls,0);
 assert.deepEqual(await facts(f),before,'预览是真实只读');
 const receipt=await apply(f,input,p.previewHash),after=await facts(f);
 assert.equal(receipt.operationType,'DOMAIN_PRODUCTION_COMPATIBILITY');assert.equal(receipt.formalAdoptionPerformed,false);
 assert.deepEqual(after.view.eventsByKind,before.view.eventsByKind);assert.deepEqual(after.media,before.media);assert.deepEqual(after.bytes,before.bytes);assert.deepEqual(after.documents,before.documents);assert.deepEqual(after.view.recipes,before.view.recipes);
 const expected=structuredClone(before.view.snapshot);expected.productionModel.domainProductionCompatibilities=[...(expected.productionModel.domainProductionCompatibilities||[]),p.record];
 assert.deepEqual(after.view.snapshot,expected);assert.deepEqual(after.view.sourceRevisionIds,before.view.sourceRevisionIds);
 const replayBefore=await f.repo.exportState(),replayed=await apply(f,input,p.previewHash);assert.equal(replayed.replayed,true);assert.deepEqual(await f.repo.exportState(),replayBefore);
 await rejectedUnchanged(f,{...input,reason:'同一操作身份不许换理由'},/身份已被其他内容占用/,p.previewHash);
 const operations=await f.store.operationalSnapshot(),current=operations.stateProjection.assetVersionsById[f.candidate.versionId];assert.equal(current.canFlowDownstream,true);
 assert.equal(operations.reviews.projectedByAssetVersion.find(r=>r.aggregateId===f.candidate.versionId)?.event.eventId,f.reviewEvent.eventId);
 assert.equal(operations.projectedReviews.byAssetVersion.find(r=>r.aggregateId===f.candidate.versionId)?.event.eventId,f.reviewEvent.eventId);
 assert.equal(current.reviewCorrection.headEventId,f.reviewEvent.eventId);assert.equal(current.reviewCorrection.state,'OPEN');
 const rejectBefore=await f.repo.exportState(),falseInitial=await reviewRequest(f);assert.equal(falseInitial.status,409,JSON.stringify(falseInitial.body));assert.equal(falseInitial.body.reasonCode,'REVIEW_CORRECTION_REQUIRES_HEAD');assert.deepEqual(await f.repo.exportState(),rejectBefore);
 assert.equal(f.externalCalls(),0);
});

test('真实 PG：没有媒体或原生计划的同条件非空范围追加只能建立 requirement 桥',pg,async t=>{
 const f=await apiFixture(t);await scopeAddition(f,'original');const authorization=await authorize(f),before=await f.repo.readView();await scopeAddition(f,'additional');
 const input=await requestFor(f,before,authorization,{requirementIds:[imageRequirementId]}),frozen=await facts(f),p=await preview(f,input);
 assert.equal(p.record.requirementBindings.length,1);assert.deepEqual(p.record.versionBindings,[]);assert.deepEqual(p.record.occurrences,[]);assert.deepEqual(p.record.contractAudit.media,[]);
 assert.notEqual(p.record.requirementBindings[0].beforeHash,p.record.requirementBindings[0].afterHash);
 await apply(f,input,p.previewHash);const after=await facts(f);assert.deepEqual(after.media,[]);assert.deepEqual(after.view.eventsByKind,frozen.view.eventsByKind);assert.deepEqual(after.view.recipes,frozen.view.recipes);assert.deepEqual(after.view.snapshot.productionModel.materialProductionPlans,frozen.view.snapshot.productionModel.materialProductionPlans);assert.equal(f.externalCalls(),0);
});

test('真实 PG：已正式通过的同族 V002 使用原返修源与真实 parent/run/definition 闭包',pg,async t=>{
 const f=await approvedFixture(t,{successor:true}),{input}=await descriptionChange(f),before=await facts(f),p=await preview(f,input);
 const audit=p.record.contractAudit.versions[0];assert.equal(audit.mode,'EXACT_REGISTERED_EXECUTION');assert.equal(audit.sources.length,2);assert.equal(p.record.versionBindings[0].executionDefinitionId,f.production.recipe.id);
 await apply(f,input,p.previewHash);const after=await facts(f);assert.deepEqual(after.view.eventsByKind,before.view.eventsByKind);assert.deepEqual(after.bytes,before.bytes);assert.deepEqual(after.documents,before.documents);assert.deepEqual(after.view.recipes,before.view.recipes);
 assert.deepEqual(after.view.snapshot.productionModel.materialProductionPlans,before.view.snapshot.productionModel.materialProductionPlans);assert.deepEqual(after.view.snapshot.productionModel.materialProductionRecipeRevisions,before.view.snapshot.productionModel.materialProductionRecipeRevisions);assert.equal(f.externalCalls(),0);
});

test('真实 PG：确认、来源、身份、预览 CAS、介入事件与新 epoch 均不能被兼容证明绕过',pg,async t=>{
 const f=await approvedFixture(t),{input}=await descriptionChange(f),p=await preview(f,input);
 for(const [name,change,pattern]of [
  ['叙事说明没有逐对象确认',r=>r.metadataApprovals=[],/变化未被证明为兼容/],
  ['确认明确为 false',r=>r.metadataApprovals[0].confirmed=false,/变化未被证明为兼容/],
  ['叙事说明确认绑定错误的旧值',r=>r.metadataApprovals[0].beforeRecordHash='0'.repeat(64),/变化未被证明为兼容/],
  ['客户端不能直接提交自造 proof',r=>r.proofHash='0'.repeat(64),/完整且精确的兼容确认清单/],
  ['授权原句不存在',r=>r.authorization.quote='发布指引中不存在的授权',/用户确认来源/],
  ['授权来源 SHA 错误',r=>r.authorization.sha256='0'.repeat(64),/用户确认来源/],
  ['旧图谱 SHA 错误',r=>r.beforeGraphRef.sha256='0'.repeat(64),/领域图谱与发布来源绑定不一致/],
  ['当前发布 CAS 错误',r=>r.expectedReleaseId='release:stale',/发布版本或运行期已变化/],
  ['原版本 SHA 错误',r=>r.versions[0].sha256='0'.repeat(64),/版本身份、原登记路径或字节变化/],
 ])await t.test(name,async()=>{const altered=structuredClone(input);change(altered);await rejectedUnchanged(f,altered,pattern);});
 await t.test('预览 SHA 不能伪造',()=>rejectedUnchanged(f,input,/预览后来源、事件或媒体变化/,'0'.repeat(64)));
 await t.test('未改发布但有介入事件，原预览必须失效',async()=>{
  const id='compatibility-test:'+randomUUID();await f.repo.writeTransaction(tx=>tx.appendEvent({kind:'verification',idempotencyKey:id,requestHash:sha256(id),payload:{issueId:'fixture:intervening',outcome:'PASS',note:'临时库无业务影响的介入事件'}}));
  assert.equal((await f.repo.readView()).releaseId,input.expectedReleaseId);await rejectedUnchanged(f,input,/预览后来源、事件或媒体变化/,p.previewHash);
 });
 const fresh=await preview(f,input);
 await t.test('新运行期不能重放旧授权 CAS',async()=>{await f.repo.writeTransaction(tx=>tx.resetRuntimeEpoch());await rejectedUnchanged(f,input,/发布版本或运行期已变化/,fresh.previewHash);});
 assert.equal(await f.repo.readTransaction(tx=>tx.getAux(DOMAIN_COMPATIBILITY_NS,input.operationId)),null);assert.equal(f.externalCalls(),0);
});

test('真实 PG：外观或表现物性变化不是叙事说明兼容',pg,async t=>{
 const f=await approvedFixture(t),authorization=await authorize(f),before=await f.repo.readView(),rep=before.snapshot.productionModel.domainGraph.representations.find(r=>r.id===imageRepresentationId);
 await changeDomain(f.repo,'MATERIAL',[{collection:'representations',id:rep.id,beforeHash:domainHash(rep),value:{...rep,dimensions:{costume:'新增明显不同的服饰物性'}}}]);
 const input=await requestFor(f,before,authorization,{versions:[target(f.production,f.candidate)]});await rejectedUnchanged(f,input,/变化未被证明为兼容/);assert.equal(f.externalCalls(),0);
});

test('真实 PG：只核原 current V001 不豁免同族未审 V002；V002 后续正式采用后不得复活 V001',pg,async t=>{
 const f=await approvedFixture(t);let extra,extraProduction;
 const {input}=await descriptionChange(f,{beforeHook:async()=>{extraProduction=await f.provision(await f.workspace(),'改前基线之后新增的同族候选。',{expectedMode:'REVISION'});extra=await f.register(extraProduction,await f.beginRun(extraProduction),pngs[1]);}});
 const before=await facts(f),beforeOp=await f.store.operationalSnapshot(),oldCandidate=beforeOp.stateProjection.assetVersionsById[extra.versionId],p=await preview(f,input);
 assert.equal(oldCandidate.canFlowDownstream,false);assert.equal(p.record.versionBindings.length,1);assert.equal(p.record.versionBindings[0].versionId,f.candidate.versionId);
 await apply(f,input,p.previewHash);const after=await facts(f),afterOp=await f.store.operationalSnapshot();
 assert.deepEqual(afterOp.stateProjection.assetVersionsById[extra.versionId],oldCandidate,'同族未列版本的完整运行态、Review、生命周期与门禁不得改变');
 assert.equal(afterOp.stateProjection.assetFamiliesById[f.production.result.familyId].currentVersionId,f.candidate.versionId);
 assert.deepEqual(after.view.snapshot.productionModel.domainInvalidations,before.view.snapshot.productionModel.domainInvalidations);assert.deepEqual(after.view.eventsByKind,before.view.eventsByKind);assert.deepEqual(after.media,before.media);assert.deepEqual(after.bytes,before.bytes);assert.deepEqual(after.documents,before.documents);assert.deepEqual(after.view.recipes,before.view.recipes);
 await f.review(extraProduction,extra,'APPROVE_AND_RELEASE');const adopted=await f.store.operationalSnapshot();assert.equal(adopted.stateProjection.assetFamiliesById[f.production.result.familyId].currentVersionId,extra.versionId);
 const retry={...input,operationId:'compatibility_'+randomUUID(),expectedReleaseId:(await f.repo.readView()).releaseId};await rejectedUnchanged(f,retry,/仍有未解决门禁或不是当前版本|只能复用改前已放行的当前原版本/);assert.equal(f.externalCalls(),0);
});

test('真实 PG：原 Review 已被退回不能复用；兼容后纠错必须指明原正式前驱',pg,async t=>{
 const f=await approvedFixture(t),{input}=await descriptionChange(f),p=await preview(f,input);await apply(f,input,p.previewHash);
 const badBefore=await f.repo.exportState(),wrong=await reviewRequest(f,{supersedesReviewEventId:'evt_missing-predecessor'});assert.equal(wrong.status,409,JSON.stringify(wrong.body));assert.equal(wrong.body.reasonCode,'REVIEW_CORRECTION_HEAD_CHANGED');assert.deepEqual(await f.repo.exportState(),badBefore);
 const correction=await reviewRequest(f,{supersedesReviewEventId:f.reviewEvent.eventId});assert.equal(correction.status,201,JSON.stringify(correction.body));assert.equal(correction.body.event.reviewEventRole,'SUPERSEDING_CORRECTION');assert.equal(correction.body.event.supersedesReviewEventId,f.reviewEvent.eventId);
 const op=await f.store.operationalSnapshot();assert.equal(op.reviews.projectedByAssetVersion.find(r=>r.aggregateId===f.candidate.versionId)?.event.eventId,correction.body.event.eventId);assert.equal(op.stateProjection.assetVersionsById[f.candidate.versionId].canFlowDownstream,false);
 const retry={...input,operationId:'compatibility_'+randomUUID(),expectedReleaseId:(await f.repo.readView()).releaseId};await rejectedUnchanged(f,retry,/原正式通过缺失、被更新|仍有未解决门禁|指定版本没有待解释/);assert.equal(f.externalCalls(),0);
});

test('真实 PG：实际已登记媒体在预览后改字节必须失败，不能只相信注册表 SHA',pg,async t=>{
 const f=await approvedFixture(t),{input}=await descriptionChange(f),p=await preview(f,input),media=await f.repo.getMedia(f.production.result.familyId,f.candidate.versionId),file=path.join(f.root,media.relativePath);
 await writeFile(file,pngs[1]);await rejectedUnchanged(f,input,/SHA|bytes|size|media|媒体|字节|文件/i,p.previewHash);assert.equal(f.externalCalls(),0);
});

async function provisionChild(f,parent,parentCandidate){
 const entity={id:'style:compatibility-child',type:'STYLE',name:'参考父素材的固定色板',aliases:[],description:'只用于协议验证的独立风格对象',authority:'A',evidence:[]};await changeDomain(f.repo,'SETTINGS',[{collection:'entities',id:entity.id,beforeHash:null,value:entity}]);
 const requirementId='demand:compatibility-child',rep={id:'representation:compatibility-child',entityId:entity.id,stateId:null,type:'STYLE_ANCHOR',label:'实际固定父版本派生色板',dimensions:{},assetFamilyIds:[],requirementIds:[requirementId],authority:'A',evidence:[]},demand={id:requirementId,title:'实际参考输入闭包夹具',representationId:rep.id,mediaType:'IMAGE',category:'style-anchor',reuseScope:'PROJECT',scope:[],evidence:[],acceptanceCriteria:['原父版本和固定色板字节可核验']};
 await changeDomain(f.repo,'MATERIAL',[{collection:'representations',id:rep.id,beforeHash:null,value:rep},{collection:'requirements',id:requirementId,beforeHash:null,value:demand}]);
 const w=await f.repo.readTransaction(tx=>getMaterialProductionWorkspace(tx,{requirementId,api:f.adapter})),saved=await f.materialPost({...f.saveBody(w,'真实固定父版本输入；不调用模型。',{inputBindings:[target(parent,parentCandidate)]}),requirementId});assert.equal(saved.status,200,JSON.stringify(saved.body));
 const p=await f.materialPost({requirementId,action:'preview',draftRevisionId:saved.body.revisionId});assert.equal(p.status,200,JSON.stringify(p.body));const queued=await f.materialPost({requirementId,action:'publish',draftRevisionId:saved.body.revisionId,previewHash:p.body.previewHash});assert.equal(queued.status,200,JSON.stringify(queued.body));
 const result=await f.repo.writeTransaction(tx=>applyMaterialProductionJob(tx,{jobId:queued.body.jobId,api:f.adapter})),view=await f.repo.readView(),production={result,recipe:view.recipes.executionDefinitions.find(r=>r.id===result.definitionId),plan:p.body.plan,view},candidate=await f.register(production,await f.beginRun(production),pngs[1]);
 const review=await reviewRequest(f,{action:'APPROVE_AND_RELEASE',requirementId,production,candidate});assert.equal(review.status,201,JSON.stringify(review.body));return {production,candidate,requirementId,reviewEvent:review.body.event};
}

test('真实 PG：真实父子输入缺父核验失败，显式纳入全部受影响版本后才可共同恢复',pg,async t=>{
 const f=await approvedFixture(t),child=await provisionChild(f,f.production,f.candidate),{input}=await descriptionChange(f),onlyChild={...input,versions:[target(child.production,child.candidate)]};
 await rejectedUnchanged(f,onlyChild,/受影响父输入没有纳入逐版本兼容核验/);
 const complete={...input,versions:[target(f.production,f.candidate),target(child.production,child.candidate)]},before=await facts(f),p=await preview(f,complete);assert.equal(p.record.versionBindings.length,2);assert.equal(p.record.contractAudit.media.length,2);
 await apply(f,complete,p.previewHash);const after=await facts(f),op=await f.store.operationalSnapshot();for(const v of complete.versions)assert.equal(op.stateProjection.assetVersionsById[v.versionId].canFlowDownstream,true);
 assert.deepEqual(after.view.eventsByKind,before.view.eventsByKind);assert.deepEqual(after.bytes,before.bytes);assert.deepEqual(after.documents,before.documents);assert.deepEqual(after.view.recipes,before.view.recipes);assert.equal(f.externalCalls(),0);
});
