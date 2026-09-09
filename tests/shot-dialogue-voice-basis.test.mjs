import test from 'node:test';
import assert from 'node:assert/strict';
import {productionHash,resolveShotProductionScope,resolveDialogueVoiceBinding,defaultShotProductionPlan,validateShotProductionPlan,compileShotProductionPlan,productionBindingReasons,shotProductionReadiness} from '../host/instance-runtime/shot-production-model.mjs';
import {reuseShotProductionObjects} from '../host/instance-runtime/shot-production-reuse.mjs';
import {canonicalJson,sha256} from '../host/instance-runtime/bytes.mjs';
import {preserveShotProductionProjection} from '../host/instance-runtime/shot-production-preservation.mjs';
import {selectShotRecipeInputFamilies} from '../host/instance-runtime/shot-production-recipe-basis.mjs';

const copy=structuredClone,sceneId='scene-dialogue',episodeUid='episode-dialogue';
const binding=(requirementId,familyId)=>({requirementId,familyId,versionId:familyId+'@V1',sha256:productionHash(familyId),purpose:requirementId.startsWith('voice')?'VOICE_MASTER':'VISUAL_REFERENCE'});
function fixture(){
 const designContent={sceneId,shots:[1,2,3].map(n=>({shotId:'shot-'+n,sceneId,order:n,title:'对白镜头 '+n,narrativeBeat:'听见信件来历',audienceTakeaway:'人物对来信产生不同反应',materialRequirementRefs:['visual',n===3?'voice-speaker-b':'voice-speaker-a']}))};
 const design={id:'design-dialogue',scopeId:sceneId,episodeUid,episodeNarrativeReleaseId:'narrative-dialogue',scopeRole:'CURRENT',sourceOperationId:'source-operation',sourceSyncState:'SUCCEEDED',content:designContent,contentHash:productionHash(designContent)};
 const model={shotPlanSetRevisions:[design],episodeNarrativeReleases:[{id:design.episodeNarrativeReleaseId,episodeUid,scopeRole:'CURRENT',sourceSyncState:'SOURCE_CURRENT',reviewInput:{scenes:[{id:sceneId,contentHash:productionHash('script')}]}}],sceneScriptRevisions:[{id:'scene-script',sceneId,scopeRole:'CURRENT',episodeNarrativeReleaseId:design.episodeNarrativeReleaseId,contentHash:productionHash('script')}],scopeLocks:[{id:'design-lock',scopeType:'SCENE',scopeId:sceneId,lockPurpose:'SHOT_PLAN_SET',lockState:'LOCKED',denominatorState:'KNOWN',shotPlanSetRevisionId:design.id,shotPlanSetRevisionHash:design.contentHash,shotIds:designContent.shots.map(s=>s.shotId)}],shots:designContent.shots.map(s=>({...s,id:s.shotId,scopeRole:'CURRENT',activeInCurrentProduction:true,shotPlanSetRevisionId:design.id,shotPlanSetRevisionHash:design.contentHash})),assetFamilies:[...['IMAGE-A','IMAGE-B'].map(id=>({id,kind:'IMAGE'})),...['VOICE-A','VOICE-B','VOICE-C'].map(id=>({id,kind:'AUDIO'}))],materialRequirements:[{id:'visual',requirementClass:'REQUIRED',assetFamilyRefs:['IMAGE-A','IMAGE-B'],entityRef:'room',stateRef:'night'},...['a','b'].map(key=>({id:'voice-speaker-'+key,requirementClass:'REQUIRED',assetFamilyRefs:key==='a'?['VOICE-A','VOICE-B']:['VOICE-C'],requirementHash:productionHash('voice-requirement-'+key),representationRef:'voice-rep-'+key}))],domainGraph:{entities:[{id:'room',type:'LOCATION'},{id:'speaker-a',type:'CHARACTER',authority:'A'},{id:'speaker-b',type:'CHARACTER',authority:'A'}],states:[{id:'night',entityId:'room',authority:'L'}],representations:['a','b'].map(key=>({id:'voice-rep-'+key,entityId:'speaker-'+key,type:'VOICE_IDENTITY',authority:'L',assetFamilyIds:key==='a'?['VOICE-A','VOICE-B']:['VOICE-C'],requirementIds:['voice-speaker-'+key]})),requirements:[],relations:[]}};
 const mapHash=productionHash('space');model.sourceHashes={productionMapSha256:mapHash};model.spatialEvidence={sourceRef:'story/space.json',sourceSha256:mapHash,locations:[{id:'room-map'}],locationPackages:[{id:'room-map',zones:[{id:'table'}],cameras:[{id:'camera-a',zoneId:'table'}]}]};
 const scope=resolveShotProductionScope(model,sceneId),draft=defaultShotProductionPlan(scope,{schemaVersion:'1.0'});
 draft.shots.forEach((shot,i)=>Object.assign(shot,{keyframeStrategy:{mode:'START_ONLY',reason:'固定机位表演',intermediateFrameCount:0},dialogueLines:[{id:'line-'+(i+1),text:'这封信是谁寄来的？',speakerEntityId:i===2?'speaker-b':'speaker-a',purpose:'FINAL',performance:'迟疑后低声询问'}],inputs:[binding('visual','IMAGE-A'),binding(i===2?'voice-speaker-b':'voice-speaker-a',i===2?'VOICE-C':'VOICE-A')],space:{loc:'room-map',state:'night',zone:'table',camera:'camera-a',freeze:mapHash},handles:{headFrames:6,tailFrames:6},videoBranch:'POST_LIP'}));
 const content=validateShotProductionPlan(draft,scope),compiled=compileShotProductionPlan(scope,content,{id:'production-a',revisionId:'source-a',sourceRef:'story/production-a.json'}),bases=model.assetFamilies;
 Object.assign(model,compiled);model.assetFamilies=[...bases,...compiled.assetFamilies];model.assetVersions=[];
 const plan={id:'production-a',sceneId,scopeRole:'CURRENT',content,contentHash:productionHash(content),sourceRevisionId:'source-a',sourcePath:'story/production-a.json',workItemIds:compiled.workItems.map(w=>w.id)};model.shotProductionPlans=[plan];
 const state={assetFamiliesById:{},assetVersionsById:{},executionGatesByWorkItem:{}};
 for(const family of model.assetFamilies){const version={id:family.id+'@V1',familyId:family.id,sha256:productionHash(family.id),path:'media/'+family.id,canFlowDownstream:true};state.assetFamiliesById[family.id]={...family,currentVersionId:version.id,canFlowDownstream:true};state.assetVersionsById[version.id]=version;}
 for(const work of model.workItems)if(work.deliverableKey==='SHOT_VIDEO'){work.executionDefinitionRef='CALL-'+work.id;state.executionGatesByWorkItem[work.id]=[];}
 const slices=content.shots.map(shot=>({shotId:shot.shotId,...Object.fromEntries(['timingHash','visualHash','overlayHash','boundaryHash'].map(key=>[key,productionHash(key+shot.shotId)]))}));model.animaticLocks=[{sceneId,scopeRole:'CURRENT',shotPlanRevisionId:design.id,shotSlices:slices}];
 model.shotInputLocks=[{sceneId,scopeRole:'CURRENT',perShotHashes:content.shots.map(({shotId,inputs,space})=>({shotId,inputHash:productionHash({shotId,inputs,space})}))}];
 model.shotKeyframeSets=content.shots.map(shot=>({id:'frames-'+shot.shotId,sceneId,scopeRole:'CURRENT',...slices.find(s=>s.shotId===shot.shotId),strategyHash:productionHash(shot.keyframeStrategy),members:model.workItems.filter(w=>w.shotId===shot.shotId&&w.gateId==='KEYFRAMES').map(w=>({workItemId:w.id,slot:w.outputSlot,familyId:w.outputAssetRef,versionId:w.outputAssetRef+'@V1',sha256:productionHash(w.outputAssetRef)}))}));
 return {model,scope,content,compiled,plan,state,read:()=>shotProductionReadiness(model,state,sceneId)};
}
const compile=(f,content,id='production-b')=>compileShotProductionPlan(f.scope,content,{id,revisionId:'source-'+id,sourceRef:'story/'+id+'.json'});
const find=(rows,kind,shotId='shot-1')=>rows.find(w=>w.shotId===shotId&&w.deliverableKey===kind);
function replacePlan(f,content){
 const normalized=validateShotProductionPlan(content,f.scope),compiled=compile(f,normalized),reuse=reuseShotProductionObjects(f.model,f.plan,compiled);
 for(const key of ['workItems','workPackages','assetFamilies','expectedOutputs','reviewContexts'])f.model[key]=[...f.model[key].map(row=>row.shotProductionPlanId&&!reuse.retained[key].has(row.id)?{...row,scopeRole:'EVIDENCE_ONLY',activeInCurrentProduction:false}:row),...reuse.additions[key]];
 f.model.shotProductionPlans=[{id:'production-b',sceneId,scopeRole:'CURRENT',content:normalized,contentHash:productionHash(normalized),sourceRevisionId:'source-production-b',workItemIds:reuse.workItemIds},{...f.plan,scopeRole:'EVIDENCE_ONLY'}];
 return {reuse,compiled,content:normalized};
}
test('same speaker switching between two valid adopted voice families changes the exact frozen dialogue basis',()=>{
 const f=fixture();assert.equal(f.read().ready,true);
 for(const familyId of ['VOICE-A','VOICE-B'])assert.deepEqual(productionBindingReasons(f.model,f.state,binding('voice-speaker-a',familyId)),[]);
 const before=find(f.compiled.workItems,'DIALOGUE_DRY'),next=copy(f.content);next.shots[0].inputs[1]=binding('voice-speaker-a','VOICE-B');const after=find(compile(f,next).workItems,'DIALOGUE_DRY');
 assert.deepEqual(before.inputAssetRefs,['VOICE-A']);assert.deepEqual(after.inputAssetRefs,['VOICE-B']);assert.notEqual(after.outputBasisHash,before.outputBasisHash);
 assert.equal(after.dialogue.voiceBinding.versionId,'VOICE-B@V1');assert.equal(after.dialogue.voiceBinding.sha256,productionHash('VOICE-B'));assert.equal(after.dialogue.voiceBinding.representationId,'voice-rep-a');
 const frozenScope={sceneId,episodeUid,plan:f.scope.plan,shots:f.scope.shots},normalized=validateShotProductionPlan(next,f.scope),historical=compileShotProductionPlan(frozenScope,normalized,{id:'production-b',revisionId:'source-production-b',sourceRef:'story/production-b.json'});
 assert.deepEqual(historical.workItems.map(w=>[w.deliverableKey,w.outputBasisHash,w.inputAssetRefs]),compile(f,normalized).workItems.map(w=>[w.deliverableKey,w.outputBasisHash,w.inputAssetRefs]));
});
test('voice replacement retires only this dialogue and its actual downstream; other lines and all images keep identities',()=>{
 const f=fixture(),next=copy(f.content);next.shots[0].inputs[1]=binding('voice-speaker-a','VOICE-B');const {reuse}=replacePlan(f,next),retired=f.compiled.workItems.filter(w=>reuse.retiredWorkItemIds.includes(w.id));
 assert.deepEqual(retired.map(w=>w.deliverableKey).sort(),['ANIMATIC','DIALOGUE_DRY','LOCKED_SHOT','SHOT_INPUT_LOCK','SHOT_VIDEO']);
 for(const work of f.compiled.workItems.filter(w=>['STORYBOARD','START_FRAME'].includes(w.deliverableKey)||w.deliverableKey==='DIALOGUE_DRY'&&w.shotId!=='shot-1'))assert(reuse.reusedWorkItemIds.includes(work.id),work.id);
 const readiness=f.read();assert.equal(readiness.shots[0].ready,false);assert(readiness.shots[0].blockers.includes('DIALOGUE_NOT_RELEASED'));assert(readiness.shots.slice(1).every(s=>s.ready));
});
test('an unrelated image change reuses the original dialogue bytes, source identity and family',()=>{
 const f=fixture(),before=copy(find(f.model.workItems,'DIALOGUE_DRY')),next=copy(f.content);next.shots[0].inputs[0]=binding('visual','IMAGE-B');const {reuse}=replacePlan(f,next);
 assert(reuse.reusedWorkItemIds.includes(before.id));assert.deepEqual(f.model.workItems.find(w=>w.id===before.id),before);
 assert.equal(find(f.model.workItems.filter(w=>w.scopeRole==='CURRENT'),'DIALOGUE_DRY').outputAssetRef,before.outputAssetRef);assert(!f.read().shots[0].blockers.includes('DIALOGUE_NOT_RELEASED'));
});
test('speaker selection, exact version/SHA and requirement relationship are independent invalidation inputs',()=>{
 for(const mutate of [f=>{f.content.shots[0].inputs[1].versionId='VOICE-A@V2';f.content.shots[0].inputs[1].sha256=productionHash('voice-a-v2');},f=>{f.content.shots[0].inputs[1].purpose='NEW_VOICE_DIRECTION';},f=>{f.model.materialRequirements.find(r=>r.id==='voice-speaker-a').requirementHash=productionHash('new voice requirement');},f=>{f.model.domainGraph.representations.find(r=>r.id==='voice-rep-a').dimensions={delivery:'lower'};}]){
  const f=fixture(),before=find(f.compiled.workItems,'DIALOGUE_DRY').outputBasisHash;mutate(f);assert.notEqual(find(compile(f,f.content).workItems,'DIALOGUE_DRY').outputBasisHash,before);
 }
 const f=fixture(),line=f.content.shots[0].dialogueLines[0],inputs=f.content.shots[0].inputs;assert.deepEqual(resolveDialogueVoiceBinding(f.model,line,[...inputs,binding('voice-speaker-b','VOICE-C')]).blockers,[]);
 for(const changed of [[],[binding('voice-speaker-b','VOICE-C')],[binding('voice-speaker-a','VOICE-A'),binding('voice-speaker-a','VOICE-B')],[binding('visual','VOICE-A')]])assert(resolveDialogueVoiceBinding(f.model,line,changed).blockers.includes('INPUT_SPEAKER_VOICE_MASTER_NOT_UNIQUE'));
});
test('old published dialogue cannot remain ready merely because its previous audio is still released',()=>{
 const f=fixture();f.content.shots[0].inputs[1]=binding('voice-speaker-a','VOICE-B');f.plan.contentHash=productionHash(f.content);
 const result=f.read();assert.equal(result.shots[0].ready,false);assert(result.shots[0].blockers.includes('PRODUCTION_WORK_INPUTS_CHANGED'));assert(result.shots[0].blockers.includes('DIALOGUE_NOT_RELEASED'));assert(result.shots.slice(1).every(s=>s.ready));
 const old=fixture(),legacyContent=copy(old.content);for(const shot of legacyContent.shots)for(const line of shot.dialogueLines)delete line.voiceBinding;
 const historical=compileShotProductionPlan({sceneId,episodeUid,plan:old.scope.plan,shots:old.scope.shots},legacyContent,{id:'legacy-production',revisionId:'legacy-source',sourceRef:'story/legacy.json'});assert.equal(find(historical.workItems,'DIALOGUE_DRY').outputBasisHash,productionHash(legacyContent.shots[0].dialogueLines[0]));assert.deepEqual(find(historical.workItems,'DIALOGUE_DRY').inputAssetRefs,[]);
 old.model.domainGraph.representations[0].authority='U';assert.equal(old.read().ready,false);assert(old.read().blockers.includes('INPUT_SPEAKER_VOICE_MASTER_NOT_UNIQUE'));
});
test('read-only partial catalogs cannot infer a speaker, requirement, voice representation or actual SHA',()=>{
 for(const mutate of [m=>delete m.domainGraph,m=>m.domainGraph.entities=[],m=>m.domainGraph.entities.push(copy(m.domainGraph.entities.find(e=>e.id==='speaker-a'))),m=>m.domainGraph.representations=[],m=>m.domainGraph.representations.push(copy(m.domainGraph.representations[0])),m=>m.materialRequirements=[],m=>delete m.materialRequirements.find(r=>r.id==='voice-speaker-a').requirementHash,m=>m.assetFamilies=[]]){
  const f=fixture();mutate(f.model);const before=canonicalJson(f.model),work=find(f.compiled.workItems,'DIALOGUE_DRY'),selected=selectShotRecipeInputFamilies(f.model,work,f.content.shots[0]);
  assert.deepEqual(selected.familyIds,[]);assert(selected.blockers.includes('INPUT_SPEAKER_VOICE_MASTER_NOT_UNIQUE'));assert.equal(canonicalJson(f.model),before);
 }
 const f=fixture();f.content.shots[0].inputs[1].sha256='missing';assert.doesNotThrow(()=>resolveDialogueVoiceBinding(f.model,f.content.shots[0].dialogueLines[0],f.content.shots[0].inputs));assert.equal(resolveDialogueVoiceBinding(f.model,f.content.shots[0].dialogueLines[0],f.content.shots[0].inputs).binding,null);
});
test('ordinary source preservation retains frozen voice plans and all owned bytes despite a later current graph change',()=>{
 const f=fixture();f.plan.episodeUid=episodeUid;
 const body={schemaVersion:'1.0',productionPlanId:f.plan.id,content:f.content,contentHash:f.plan.contentHash,shotPlanRevisionId:f.scope.plan.id},bytes=Buffer.from(canonicalJson(body));f.plan.sourceSha256=sha256(bytes);
 const documents=[{revisionId:f.plan.sourceRevisionId,sha256:f.plan.sourceSha256,bytes,aliases:[f.plan.sourcePath],metadata:{sourceRole:'SHOT_PRODUCTION_PLAN'}}];
 f.model.domainGraph.entities.find(e=>e.id==='speaker-a').description='后续已确认身份说明';
 const original=canonicalJson({plan:f.plan,works:f.model.workItems,packages:f.model.workPackages,contexts:f.model.reviewContexts,documents});
 const result=preserveShotProductionProjection({snapshot:{productionModel:{shots:copy(f.model.shots),shotPlanSetRevisions:copy(f.model.shotPlanSetRevisions)}},baseSnapshot:{productionModel:f.model},documents}).productionModel;
 for(const key of ['shotProductionPlans','workItems','workPackages','reviewContexts','expectedOutputs'])assert.deepEqual(result[key],f.model[key],key);
 assert.equal(canonicalJson({plan:f.plan,works:f.model.workItems,packages:f.model.workPackages,contexts:f.model.reviewContexts,documents}),original);
 assert(f.read().blockers.includes('PRODUCTION_WORK_INPUTS_CHANGED'),'current eligibility still invalidates while historical bytes stay fixed');
});
